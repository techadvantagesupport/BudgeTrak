package com.techadvantage.budgetrak.data.ocr

import android.content.Context
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
import kotlinx.coroutines.withTimeout
import org.json.JSONObject

object ReceiptOcrService {
    private const val TAG = "ReceiptOcrService"
    private const val MODEL_NAME = "gemini-2.5-flash"
    private const val TIMEOUT_MS = 90_000L

    // `lineItems` intentionally omitted — harness A/B test (2026-04-16) showed
    // dropping it from the response saves ~53% output tokens with no loss to
    // category accuracy. See memory/project_ocr_receipt_capture.md. When a
    // future item-view feature needs it, re-add both here and in the parser.
    private val responseSchema = Schema.obj(
        name = "OcrResult",
        description = "Receipt extraction result",
        Schema.str("merchant", "Consumer brand on the receipt header"),
        Schema.str("merchantLegalName", "Optional legal operator entity"),
        Schema.str("date", "Transaction date in YYYY-MM-DD"),
        Schema.double("amount", "Final total paid"),
        Schema.arr(
            "categoryAmounts",
            "Per-category amounts that sum to the total",
            Schema.obj(
                name = "CategoryAmount",
                description = "One category's share of the receipt",
                Schema.int("categoryId", "Category id from the user's list"),
                Schema.double("amount", "Amount for this category")
            )
        ),
        Schema.str("notes", "Optional free-form note")
    )

    private val model by lazy {
        GenerativeModel(
            modelName = MODEL_NAME,
            apiKey = BuildConfig.GEMINI_API_KEY,
            generationConfig = generationConfig {
                responseMimeType = "application/json"
                responseSchema = this@ReceiptOcrService.responseSchema
                temperature = 0f
            }
        )
    }

    suspend fun extractFromReceipt(
        context: Context,
        receiptId: String,
        categories: List<Category>
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

            val prompt = buildOcrPrompt(categories)

            val jsonText = withTimeout(TIMEOUT_MS) {
                val response = model.generateContent(
                    content {
                        image(bitmap)
                        text(prompt)
                    }
                )
                response.text ?: throw IllegalStateException("Empty response from model")
            }

            bitmap.recycle()
            Result.success(parseOcrResult(jsonText))
        } catch (e: Exception) {
            Log.w(TAG, "OCR failed for receipt $receiptId: ${e.message}")
            runCatching { FirebaseCrashlytics.getInstance().recordException(e) }
            Result.failure(e)
        }
    }

    private fun parseOcrResult(jsonText: String): OcrResult {
        val json = JSONObject(jsonText)
        val merchant = json.optString("merchant").takeIf { it.isNotBlank() }
            ?: throw IllegalStateException("Missing merchant in OCR response")
        val date = json.optString("date").takeIf { it.isNotBlank() }
            ?: throw IllegalStateException("Missing date in OCR response")
        val amount = json.optDouble("amount", Double.NaN).takeIf { !it.isNaN() }
            ?: throw IllegalStateException("Missing amount in OCR response")

        val cats = json.optJSONArray("categoryAmounts")?.let { arr ->
            (0 until arr.length()).mapNotNull { i ->
                val o = arr.optJSONObject(i) ?: return@mapNotNull null
                val cid = o.optInt("categoryId", -1).takeIf { it > 0 } ?: return@mapNotNull null
                val amt = o.optDouble("amount", Double.NaN).takeIf { !it.isNaN() } ?: return@mapNotNull null
                OcrCategoryAmount(categoryId = cid, amount = amt)
            }
        }
        val lineItems = json.optJSONArray("lineItems")?.let { arr ->
            (0 until arr.length()).map { arr.optString(it) }.filter { it.isNotBlank() }
        }

        return OcrResult(
            merchant = merchant,
            merchantLegalName = json.optString("merchantLegalName").takeIf { it.isNotBlank() },
            date = date,
            amount = amount,
            categoryAmounts = cats?.takeIf { it.isNotEmpty() },
            lineItems = lineItems?.takeIf { it.isNotEmpty() },
            notes = json.optString("notes").takeIf { it.isNotBlank() }
        )
    }
}
