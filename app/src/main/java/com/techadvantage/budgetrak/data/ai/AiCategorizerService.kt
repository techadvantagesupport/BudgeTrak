package com.techadvantage.budgetrak.data.ai

import android.util.Log
import com.google.ai.client.generativeai.GenerativeModel
import com.google.ai.client.generativeai.type.Schema
import com.google.ai.client.generativeai.type.content
import com.google.ai.client.generativeai.type.generationConfig
import com.google.firebase.crashlytics.FirebaseCrashlytics
import com.techadvantage.budgetrak.BuildConfig
import com.techadvantage.budgetrak.data.Category
import com.techadvantage.budgetrak.data.Transaction
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.withTimeout
import org.json.JSONArray
import org.json.JSONObject

object AiCategorizerService {
    private const val TAG = "AiCategorizerService"
    private const val TIMEOUT_MS = 30_000L
    private const val CHUNK_SIZE = 100

    private val schema = Schema.obj(
        name = "CategorizerResult",
        description = "One category id per transaction index",
        Schema.arr(
            "results",
            "One entry per transaction",
            Schema.obj(
                name = "Entry",
                description = "Transaction index and assigned category id",
                Schema.int("i", "The transaction index from the input"),
                Schema.int("categoryId", "Category id chosen from the provided list")
            )
        )
    )

    private val liteModel by lazy {
        GenerativeModel(
            modelName = "gemini-2.5-flash-lite",
            apiKey = BuildConfig.GEMINI_API_KEY,
            generationConfig = generationConfig {
                responseMimeType = "application/json"
                responseSchema = schema
                temperature = 0f
            }
        )
    }

    /**
     * Categorize a batch of transactions in a single call (chunked at 100).
     * Returns a map from input index → categoryId. Entries missing from the map
     * (model skipped them, returned unknown id, or the whole call failed) should
     * fall back to whatever the caller had before AI ran.
     */
    suspend fun categorizeBatch(
        transactions: List<Transaction>,
        categories: List<Category>
    ): Result<Map<Int, Int>> {
        if (transactions.isEmpty()) return Result.success(emptyMap())
        return try {
            if (BuildConfig.GEMINI_API_KEY.isBlank()) {
                return Result.failure(IllegalStateException("GEMINI_API_KEY missing"))
            }
            val validIds = categories.filter { !it.deleted }.map { it.id }.toSet()
            val merged = mutableMapOf<Int, Int>()
            transactions.chunked(CHUNK_SIZE).forEach { chunk ->
                val jsonText = withTimeout(TIMEOUT_MS) {
                    generateWithRetry(chunk, categories)
                }
                merged.putAll(parseResults(jsonText, validIds))
            }
            Result.success(merged)
        } catch (ce: CancellationException) {
            throw ce
        } catch (e: Exception) {
            Log.w(TAG, "Categorization failed: ${e.message?.take(160)}")
            runCatching { FirebaseCrashlytics.getInstance().recordException(e) }
            Result.failure(e)
        }
    }

    private val transientPattern = Regex(
        "503|UNAVAILABLE|overloaded|429|RESOURCE_EXHAUSTED|deadline|fetch failed|network|ECONNRESET|ETIMEDOUT|socket",
        RegexOption.IGNORE_CASE
    )

    private suspend fun generateWithRetry(
        batch: List<Transaction>,
        categories: List<Category>
    ): String {
        // We send only merchant + amount (not date) to minimise data shared
        // with Google. Merchant is the dominant categorization signal;
        // amount occasionally nudges edge cases (e.g. small vs large charges
        // at mixed-purpose retailers). Date adds almost nothing for typical
        // consumer receipts and isn't worth the extra payload.
        val arr = JSONArray()
        batch.forEachIndexed { idx, t ->
            arr.put(JSONObject().apply {
                put("i", idx)
                put("merchant", t.source)
                put("amount", t.amount)
            })
        }
        val batchJson = JSONObject().put("transactions", arr).toString()
        val prompt = buildCategorizerPrompt(categories, batchJson)

        val maxAttempts = 3
        var lastErr: Exception? = null
        for (attempt in 1..maxAttempts) {
            try {
                val response = liteModel.generateContent(content { text(prompt) })
                return response.text ?: throw IllegalStateException("Empty categorizer response")
            } catch (ce: CancellationException) {
                throw ce
            } catch (e: Exception) {
                lastErr = e
                val transient = e.message?.let { transientPattern.containsMatchIn(it) } ?: false
                if (!transient || attempt == maxAttempts) throw e
                Log.d(TAG, "Transient categorizer error attempt $attempt/$maxAttempts: ${e.message?.take(100)}")
                delay(500L shl (attempt - 1))
            }
        }
        throw lastErr ?: IllegalStateException("retry loop exited without result")
    }

    private fun parseResults(jsonText: String, validCategoryIds: Set<Int>): Map<Int, Int> {
        val obj = JSONObject(jsonText)
        val arr = obj.optJSONArray("results") ?: return emptyMap()
        val out = mutableMapOf<Int, Int>()
        for (i in 0 until arr.length()) {
            val entry = arr.optJSONObject(i) ?: continue
            val idx = entry.optInt("i", -1).takeIf { it >= 0 } ?: continue
            val catId = entry.optInt("categoryId", -1).takeIf { it > 0 && it in validCategoryIds } ?: continue
            out[idx] = catId
        }
        return out
    }
}
