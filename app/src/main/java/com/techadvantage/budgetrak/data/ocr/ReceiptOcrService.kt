package com.techadvantage.budgetrak.data.ocr

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.util.Log
import com.google.ai.client.generativeai.GenerativeModel
import com.google.ai.client.generativeai.type.Schema
import com.google.ai.client.generativeai.type.content
import com.google.ai.client.generativeai.type.generationConfig
import com.google.firebase.crashlytics.FirebaseCrashlytics
import com.techadvantage.budgetrak.BuildConfig
import com.techadvantage.budgetrak.data.Category
import com.techadvantage.budgetrak.data.sync.ReceiptManager
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.withTimeout
import org.json.JSONObject

/**
 * 3-call Gemini 2.5 Flash-Lite receipt OCR pipeline.
 *
 *   Call 1 (header): merchant, date, amountCents
 *   Call 2 (items):  {description, categoryId} per line, with category rules
 *   Call 3 (prices): priceCents per line, using multiplier / coupon / rebate cues
 *
 * Post-processing:
 *   - Invalid categoryId remap (Gemini sometimes invents ids for tax lines when
 *     the provided cat list has no natural tax home).
 *   - Proportional reconciliation so Σ(item prices) = Call 1's amountCents.
 *     Receipt-level discounts (Target Circle, Walmart DISCOUNT GIVEN) are
 *     absorbed here since line items encode only pre-discount printed prices.
 *   - Aggregate by category → OcrResult.categoryAmounts (tax allocated to the
 *     dominant non-tax bucket, matching the app's labelling convention).
 *
 * Source of truth: tools/ocr-harness/scripts/test-bakeoff-lite3-vs-pro.js.
 * Measured on 14 multi-cat receipts: cset 12/14, cshr 4/14, avg $0.00078,
 * avg 9.5s. Beats Pro single-call on cset, ~4× cheaper, ~4× faster.
 */
object ReceiptOcrService {
    private const val TAG = "ReceiptOcrService"
    private const val TIMEOUT_MS = 90_000L

    // ── Schemas ────────────────────────────────────────────────────

    private val call1Schema = Schema.obj(
        name = "Call1Result",
        description = "Receipt header",
        Schema.str("merchant", "Consumer brand on the receipt header"),
        Schema.str("merchantLegalName", "Optional legal operator entity"),
        Schema.str("date", "Transaction date in YYYY-MM-DD"),
        Schema.int("amountCents", "Final total paid, integer cents"),
        Schema.str("notes", "Optional free-form note")
    )

    private val call2Schema = Schema.obj(
        name = "Call2Result",
        description = "Itemized receipt with categories",
        Schema.arr(
            "lineItems",
            "One entry per purchased line plus Sales Tax",
            Schema.obj(
                name = "LineItem",
                description = "A purchased line item",
                Schema.str("description", "Item text as printed on the receipt"),
                Schema.int("categoryId", "Category id from the provided list")
            )
        )
    )

    private val call3Schema = Schema.obj(
        name = "Call3Result",
        description = "Prices per line item",
        Schema.arr(
            "prices",
            "Parallel array to the input item list; priceCents per item",
            Schema.obj(
                name = "ItemPrice",
                description = "Price in integer cents",
                Schema.str("description", "Item text (mirrors input)"),
                Schema.int("priceCents", "Paid price in cents after line discounts")
            )
        )
    )

    // Single-call (0-1 preselected cats): header + one categoryAmounts entry.
    private val singleCallSchema = Schema.obj(
        name = "SingleCallResult",
        description = "Receipt extraction — single-cat duty",
        Schema.str("merchant", "Consumer brand on the receipt header"),
        Schema.str("merchantLegalName", "Optional legal operator entity"),
        Schema.str("date", "Transaction date in YYYY-MM-DD"),
        Schema.int("amountCents", "Final total paid, integer cents"),
        Schema.arr(
            "categoryAmounts",
            "Single-entry array with the best-fit category",
            Schema.obj(
                name = "CategoryAmount",
                description = "The receipt's primary category",
                Schema.int("categoryId", "Category id from the provided list"),
                Schema.double("amount", "Amount for this category (should equal the total)")
            )
        ),
        Schema.str("notes", "Optional free-form note")
    )

    // ── Models (separate instances per call — SDK binds schema to config) ─

    private val call1Model by lazy { liteModel(call1Schema) }
    private val call2Model by lazy { liteModel(call2Schema) }
    private val call3Model by lazy { liteModel(call3Schema) }
    private val singleCallModel by lazy { liteModel(singleCallSchema) }

    private fun liteModel(schema: Schema<*>) = GenerativeModel(
        modelName = "gemini-2.5-flash-lite",
        apiKey = BuildConfig.GEMINI_API_KEY,
        generationConfig = generationConfig {
            responseMimeType = "application/json"
            responseSchema = schema
            temperature = 0f
        }
    )

    // ── Public API ─────────────────────────────────────────────────

    /**
     * Extract receipt data.
     *
     * Routing by pre-selection:
     *   • 0-1 pre-selected cats → single-call path (1 API call). Assumes the
     *     receipt belongs to one category — the model returns a single
     *     categoryAmounts entry. Cheapest/fastest for typical receipts.
     *   • 2+ pre-selected cats → 3-call pipeline (header + items+cats + prices,
     *     then reconcile). Needed for multi-cat receipts (Target/Costco/etc)
     *     where the user wants a split across buckets.
     */
    suspend fun extractFromReceipt(
        context: Context,
        receiptId: String,
        categories: List<Category>,
        preSelectedCategoryIds: Set<Int> = emptySet()
    ): Result<OcrResult> {
        return try {
            if (BuildConfig.GEMINI_API_KEY.isBlank()) {
                return Result.failure(IllegalStateException("GEMINI_API_KEY missing from local.properties"))
            }
            val file = ReceiptManager.getReceiptFile(context, receiptId)
            if (!file.exists()) {
                return Result.failure(IllegalStateException("Receipt file not found: $receiptId"))
            }
            val bitmap = BitmapFactory.decodeFile(file.absolutePath)
                ?: return Result.failure(IllegalStateException("Could not decode receipt image"))

            val result = withTimeout(TIMEOUT_MS) {
                if (preSelectedCategoryIds.size >= 2) {
                    runThreeCallPipeline(bitmap, categories, preSelectedCategoryIds)
                } else {
                    runSingleCall(bitmap, categories, preSelectedCategoryIds)
                }
            }
            bitmap.recycle()
            Result.success(result)
        } catch (ce: CancellationException) {
            throw ce
        } catch (e: Exception) {
            Log.w(TAG, "OCR failed for receipt $receiptId: ${e.message}")
            runCatching { FirebaseCrashlytics.getInstance().recordException(e) }
            Result.failure(e)
        }
    }

    // ── Single-call path (0-1 preselected) ─────────────────────────

    private suspend fun runSingleCall(
        bitmap: Bitmap,
        allCategories: List<Category>,
        preSelectedCategoryIds: Set<Int>
    ): OcrResult {
        val promptCats = if (preSelectedCategoryIds.isNotEmpty()) {
            allCategories.filter { it.id in preSelectedCategoryIds }
        } else {
            allCategories.filter { it.tag != "supercharge" && it.tag != "recurring_income" && !it.deleted }
        }
        val json = JSONObject(generateWithRetry(singleCallModel, bitmap, buildSingleCallPrompt(promptCats)))

        val merchant = json.optString("merchant").takeIf { it.isNotBlank() }
            ?: throw IllegalStateException("Missing merchant in OCR response")
        val merchantLegalName = json.optString("merchantLegalName").takeIf { it.isNotBlank() }
        val date = json.optString("date").takeIf { it.isNotBlank() }
            ?: throw IllegalStateException("Missing date in OCR response")
        val amountCents = json.optInt("amountCents", -1).takeIf { it >= 0 }
            ?: throw IllegalStateException("Missing amountCents in OCR response")
        val notes = json.optString("notes").takeIf { it.isNotBlank() }

        // Single-call emits one categoryAmounts entry (single-cat duty). If the
        // model hallucinates an id not in promptCats, remap. If it omits the
        // entry entirely, synthesize one from the first preselected cat.
        val validSet = promptCats.mapTo(mutableSetOf()) { it.id }
        val rawCatId = json.optJSONArray("categoryAmounts")
            ?.optJSONObject(0)
            ?.optInt("categoryId", -1)
            ?.takeIf { it != -1 }
        val categoryId = when {
            rawCatId != null && rawCatId in validSet -> rawCatId
            preSelectedCategoryIds.size == 1 -> preSelectedCategoryIds.first()
            rawCatId != null -> remapSingleCategoryId(rawCatId, promptCats)
            else -> null
        }
        val categoryAmounts = categoryId?.let {
            listOf(OcrCategoryAmount(categoryId = it, amount = amountCents / 100.0))
        }

        return OcrResult(
            merchant = merchant,
            merchantLegalName = merchantLegalName,
            date = date,
            amount = amountCents / 100.0,
            categoryAmounts = categoryAmounts,
            lineItems = null,
            notes = notes
        )
    }

    private fun remapSingleCategoryId(cid: Int, cats: List<Category>): Int? {
        val valid = cats.mapTo(mutableSetOf()) { it.id }
        return when {
            cid in valid -> cid
            30426 in valid -> 30426
            else -> cats.firstOrNull()?.id
        }
    }

    // ── 3-call pipeline (2+ preselected) ───────────────────────────

    private suspend fun runThreeCallPipeline(
        bitmap: Bitmap,
        allCategories: List<Category>,
        preSelectedCategoryIds: Set<Int>
    ): OcrResult {
        val preselected = preSelectedCategoryIds.isNotEmpty()
        val promptCats = if (preselected) {
            allCategories.filter { it.id in preSelectedCategoryIds }
        } else {
            allCategories.filter { it.tag != "supercharge" && it.tag != "recurring_income" && !it.deleted }
        }

        // Call 1 — header
        val c1Json = generateWithRetry(call1Model, bitmap, buildCall1Prompt())
        val c1 = JSONObject(c1Json)
        val merchant = c1.optString("merchant").takeIf { it.isNotBlank() }
            ?: throw IllegalStateException("Missing merchant in Call 1")
        val merchantLegalName = c1.optString("merchantLegalName").takeIf { it.isNotBlank() }
        val date = c1.optString("date").takeIf { it.isNotBlank() }
            ?: throw IllegalStateException("Missing date in Call 1")
        val amountCents = c1.optInt("amountCents", -1).takeIf { it >= 0 }
            ?: throw IllegalStateException("Missing amountCents in Call 1")
        val notes = c1.optString("notes").takeIf { it.isNotBlank() }

        // Call 2 — items + categories
        val c2Json = generateWithRetry(call2Model, bitmap, buildCall2Prompt(promptCats, preselected))
        val c2 = JSONObject(c2Json)
        val itemsRaw = c2.optJSONArray("lineItems")?.let { arr ->
            (0 until arr.length()).mapNotNull { i ->
                val o = arr.optJSONObject(i) ?: return@mapNotNull null
                val desc = o.optString("description").takeIf { it.isNotBlank() } ?: return@mapNotNull null
                val cid = o.optInt("categoryId", -1).takeIf { it != -1 } ?: return@mapNotNull null
                LineItem(desc, cid)
            }
        } ?: emptyList()
        val items = remapInvalidCategoryIds(itemsRaw, promptCats)

        // Call 3 — per-item prices
        val c3Json = generateWithRetry(call3Model, bitmap, buildCall3Prompt(items.map { it.description }))
        val c3 = JSONObject(c3Json)
        val priceCentsRaw = c3.optJSONArray("prices")?.let { arr ->
            (0 until arr.length()).map { i ->
                arr.optJSONObject(i)?.optInt("priceCents", 0) ?: 0
            }
        } ?: List(items.size) { 0 }
        // Align lengths — model occasionally returns fewer entries than requested.
        val priceCents = List(items.size) { i -> priceCentsRaw.getOrNull(i) ?: 0 }

        // Reconcile to Call 1's amountCents
        val reconciled = reconcilePrices(items, priceCents, amountCents)

        // Aggregate categoryAmounts (tax rolled into dominant non-tax bucket)
        val categoryAmounts = aggregateCategoryAmounts(items, reconciled)

        return OcrResult(
            merchant = merchant,
            merchantLegalName = merchantLegalName,
            date = date,
            amount = amountCents / 100.0,
            categoryAmounts = categoryAmounts,
            lineItems = items.map { it.description }.ifEmpty { null },
            notes = notes
        )
    }

    // ── Prompts ────────────────────────────────────────────────────

    private fun buildSingleCallPrompt(cats: List<Category>): String {
        val categoryList = cats.joinToString("\n") { c ->
            if (c.tag.isNotEmpty()) "  - id=${c.id} name=\"${c.name}\" tag=\"${c.tag}\""
            else                    "  - id=${c.id} name=\"${c.name}\""
        }
        return """Extract receipt header data and assign the receipt's best-fit category. Return JSON {merchant, merchantLegalName?, date, amountCents (integer), categoryAmounts, notes?}.

- merchant: the consumer brand (e.g. "McDonald's", "Target"). Prefer the consumer brand over the legal operator entity. Preserve original language; don't translate.
- merchantLegalName: optional, only when the legal entity is clearly distinct from the consumer brand.
- date: YYYY-MM-DD ISO. Prefer transaction date over print/due dates. DD/MM locales: Malaysia, Singapore, Vietnam, most of Europe. MM/DD: US.
- amountCents: INTEGER cents for the final paid total (tax and tip included). Ignore subtotal and pre-tax lines. Vietnamese đồng (VND) — dots are thousand separators, return integer đồng.
- categoryAmounts: a single-entry array [{categoryId, amount}] where amount equals the receipt total. Pick the best-fit category from the list below. Stationery / office / pens / paper / bookstores → Other unless clearly kids' school supplies (→ Kid's Stuff). Hardware / electrical / plumbing / paint → Home Supplies.

Categories:
$categoryList

Do not invent categoryIds not in the list."""
    }

    private fun buildCall1Prompt(): String =
        """Extract receipt header data as JSON: {merchant, merchantLegalName?, date, amountCents (integer), notes?}.

- merchant: the consumer brand (e.g. "McDonald's", "Target", "Costco"). Prefer the consumer brand over the legal operator entity. Preserve original language; don't translate.
- merchantLegalName: optional, only when the legal entity is clearly distinct from the consumer brand.
- date: YYYY-MM-DD ISO. Receipts often have multiple dates; prefer the transaction date over print/due dates. DD/MM locales: Malaysia, Singapore, Vietnam, most of Europe. MM/DD: US.
- amountCents: INTEGER number of cents for the final paid total (tax and tip included). Ignore subtotal, pre-tax lines, and separate GST/VAT summary tables. Vietnamese đồng (VND) has no fractional unit — dots in VND amounts are thousand separators; return the integer đồng value."""

    private fun buildCall2Prompt(cats: List<Category>, preselected: Boolean): String {
        val categoryList = cats.joinToString("\n") { c ->
            if (c.tag.isNotEmpty()) "  - id=${c.id} name=\"${c.name}\" tag=\"${c.tag}\""
            else                    "  - id=${c.id} name=\"${c.name}\""
        }
        val preselectNudge = if (preselected) {
            """

  - The categories below are pre-selected by the shopper for this receipt. Try to cover as many of them as reasonably fit — the shopper expects to see items in these specific buckets. But skip a category if no item on the receipt plausibly fits it; never force-fit an item into a bucket that clearly doesn't match (the shopper may have pre-selected a category by accident).
  - When an item could plausibly fit either a niche/specialty category (e.g. Holidays/Birthdays, Kid's Stuff, Entertainment, Clothes, Health/Pharmacy) or a general catch-all (e.g. Groceries, Home Supplies, Other), prefer the niche category. Niche categories are under-filled by default; err toward the specific bucket when the item has a clear specialty signal."""
        } else ""

        return """List every PURCHASED item with a category. Return JSON {lineItems: [{description, categoryId}]}.

Rules:
  - Skip promos, coupons, discounts, tenders, subtotals.
  - Prefer a concrete consumer category (Groceries, Home Supplies, Health/Pharmacy, Clothes, Entertainment, Holidays, Kid's Stuff) over "Other".
  - Avoid these unless the item is unambiguously that type: Mortgage/Insurance/PropTax (42007), Insurance (36973), Transportation/Gas (48281 — only fuel/parking/transit), Electric/Gas (17132 — only utility bills), Phone/Internet/Computer (62776 — only service bills), Business, Employment, Farm, Charity.$preselectNudge

Include "Sales Tax" as a line item. Categories:
$categoryList"""
    }

    private fun buildCall3Prompt(descriptions: List<String>): String {
        val listed = descriptions.mapIndexed { i, d -> "  ${i + 1}. $d" }.joinToString("\n")
        return """You have a receipt image and a list of items the shopper purchased. For each item, find it on the receipt and determine the ACTUAL PAID PRICE — what contributed to the subtotal — in integer cents.

Apply these clues when reading each line:
  1. Base printed price for the item's line.
  2. Quantity multiplier: lines like "2 AT 1 FOR ${'$'}X.XX", "3 @ ${'$'}X.XX ea", or "4 FOR ${'$'}X.XX" mean the actual charge is the multiplier × unit price. Use the line's total, not the unit price.
  3. Line-level coupons or manufacturer rebates (a subsequent line with a negative amount, e.g. "COUPON -${'$'}3.00") reduce that item's price.
  4. Weight-priced items: use the computed total already printed.
  5. For "Sales Tax", return the printed tax amount in cents.

Return JSON {prices: [{description, priceCents}]}, one entry per input item, preserving the order given. priceCents is a non-negative integer.

Items:
$listed"""
    }

    // ── Retry + transient handling ─────────────────────────────────

    private val transientPattern = Regex(
        "503|UNAVAILABLE|overloaded|429|RESOURCE_EXHAUSTED|deadline|fetch failed|network|ECONNRESET|ETIMEDOUT|socket",
        RegexOption.IGNORE_CASE
    )

    private fun isTransient(msg: String?): Boolean =
        msg?.let { transientPattern.containsMatchIn(it) } ?: false

    private suspend fun generateWithRetry(
        model: GenerativeModel,
        bitmap: Bitmap,
        prompt: String
    ): String {
        val maxAttempts = 4
        var lastErr: Exception? = null
        for (attempt in 1..maxAttempts) {
            try {
                val response = model.generateContent(
                    content {
                        image(bitmap)
                        text(prompt)
                    }
                )
                return response.text ?: throw IllegalStateException("Empty response from model")
            } catch (ce: CancellationException) {
                throw ce
            } catch (e: Exception) {
                lastErr = e
                if (!isTransient(e.message) || attempt == maxAttempts) throw e
                Log.d(TAG, "Transient error on attempt $attempt/$maxAttempts, retrying: ${e.message?.take(100)}")
                delay(500L shl (attempt - 1))
            }
        }
        throw lastErr ?: IllegalStateException("retry loop exited without result")
    }

    // ── Post-processing ────────────────────────────────────────────

    internal data class LineItem(val description: String, val categoryId: Int)

    /**
     * Remap any line-item categoryId not in the provided cats list to a safe
     * fallback. Needed because when the model can't place an item (commonly
     * "Sales Tax" when no preselected cat is a natural tax home), it sometimes
     * emits a hallucinated integer like 99999 or 10000.
     */
    internal fun remapInvalidCategoryIds(
        items: List<LineItem>,
        cats: List<Category>
    ): List<LineItem> {
        val validSet = cats.mapTo(mutableSetOf()) { it.id }
        if (items.all { it.categoryId in validSet }) return items

        val fallback = when {
            30426 in validSet -> 30426  // "Other" if available
            else -> {
                val counts = HashMap<Int, Int>()
                for (it in items) if (it.categoryId in validSet) counts[it.categoryId] = (counts[it.categoryId] ?: 0) + 1
                counts.maxByOrNull { it.value }?.key ?: cats.firstOrNull()?.id ?: return items
            }
        }
        return items.map { if (it.categoryId in validSet) it else it.copy(categoryId = fallback) }
    }

    /**
     * Scale non-tax items so Σ(prices) == amountCents exactly. Receipt-level
     * discounts (Target Circle 5%, Walmart DISCOUNT GIVEN, loyalty savings at
     * subtotal) don't attach to any one line, so we distribute the delta
     * proportionally and keep the tax line exact. Residual from rounding is
     * absorbed into the largest non-tax item.
     */
    internal fun reconcilePrices(
        items: List<LineItem>,
        rawPriceCents: List<Int>,
        amountCents: Int
    ): List<Int> {
        if (items.isEmpty()) return emptyList()
        val taxIdx = items.indexOfFirst { isTaxLine(it.description) }
        val taxCents = if (taxIdx >= 0) rawPriceCents[taxIdx] else 0
        val targetNonTax = amountCents - taxCents
        val rawNonTaxSum = rawPriceCents.withIndex().sumOf { (i, c) -> if (i == taxIdx) 0 else c }
        if (rawNonTaxSum <= 0) return rawPriceCents.toList()

        val scale = targetNonTax.toDouble() / rawNonTaxSum
        val reconciled = rawPriceCents.mapIndexed { i, c ->
            if (i == taxIdx) c else kotlin.math.round(c * scale).toInt()
        }.toMutableList()

        val actualSum = reconciled.sum()
        val residual = amountCents - actualSum
        if (residual != 0) {
            var largestIdx = -1
            var largestVal = -1
            for (i in reconciled.indices) {
                if (i == taxIdx) continue
                if (reconciled[i] > largestVal) { largestVal = reconciled[i]; largestIdx = i }
            }
            if (largestIdx >= 0) reconciled[largestIdx] += residual
        }
        return reconciled
    }

    private fun isTaxLine(desc: String): Boolean =
        Regex("sales\\s*tax", RegexOption.IGNORE_CASE).containsMatchIn(desc)

    /**
     * Build categoryAmounts by summing reconciled line prices per categoryId.
     * Sales Tax is allocated to the dominant non-tax category so the UI sees
     * one coherent split that matches labelling conventions.
     */
    internal fun aggregateCategoryAmounts(
        items: List<LineItem>,
        reconciledPriceCents: List<Int>
    ): List<OcrCategoryAmount>? {
        if (items.isEmpty()) return null
        val byCat = LinkedHashMap<Int, Int>()
        var taxCents = 0
        for (i in items.indices) {
            val cents = reconciledPriceCents.getOrNull(i) ?: 0
            if (isTaxLine(items[i].description)) {
                taxCents += cents
            } else {
                byCat[items[i].categoryId] = (byCat[items[i].categoryId] ?: 0) + cents
            }
        }
        if (byCat.isEmpty()) {
            // Nothing but tax? Fall through as a single-entry result.
            val cid = items.firstOrNull()?.categoryId ?: return null
            return listOf(OcrCategoryAmount(categoryId = cid, amount = taxCents / 100.0))
        }
        if (taxCents > 0) {
            val dominantCid = byCat.maxByOrNull { it.value }?.key
            if (dominantCid != null) byCat[dominantCid] = (byCat[dominantCid] ?: 0) + taxCents
        }
        return byCat.map { (cid, cents) -> OcrCategoryAmount(categoryId = cid, amount = cents / 100.0) }
    }
}
