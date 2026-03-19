package com.syncbudget.app.data.sync

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.util.Log
import com.syncbudget.app.data.CryptoHelper
import com.syncbudget.app.data.SafeIO
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.UUID

/**
 * Manages receipt photos locally: capture, downsize, encrypt/decrypt,
 * store, thumbnails, and the pending upload queue.
 */
object ReceiptManager {

    private const val TAG = "ReceiptManager"
    private const val MAX_IMAGE_DIMENSION = 1000
    private const val THUMBNAIL_SIZE = 200
    private const val PENDING_QUEUE_FILE = "pending_receipt_uploads.json"
    private const val RECEIPTS_DIR = "receipts"
    private const val THUMBS_DIR = "receipt_thumbs"

    // ── Pending Upload Queue ────────────────────────────────────

    private val pendingQueueLock = Any()

    fun loadPendingUploads(context: Context): MutableSet<String> {
        synchronized(pendingQueueLock) {
            return try {
                val file = File(context.filesDir, PENDING_QUEUE_FILE)
                if (!file.exists()) return mutableSetOf()
                val json = JSONArray(file.readText())
                (0 until json.length()).mapTo(mutableSetOf()) { json.getString(it) }
            } catch (e: Exception) {
                Log.w(TAG, "Failed to load pending uploads: ${e.message}")
                mutableSetOf()
            }
        }
    }

    fun savePendingUploads(context: Context, pendingIds: Set<String>) {
        synchronized(pendingQueueLock) {
            try {
                val json = JSONArray()
                pendingIds.forEach { json.put(it) }
                SafeIO.atomicWriteJson(context, PENDING_QUEUE_FILE, json)
            } catch (e: Exception) {
                Log.w(TAG, "Failed to save pending uploads: ${e.message}")
            }
        }
    }

    fun addToPendingQueue(context: Context, receiptId: String) {
        synchronized(pendingQueueLock) {
            val pending = loadPendingUploadsInternal(context)
            pending.add(receiptId)
            savePendingUploadsInternal(context, pending)
        }
    }

    fun removeFromPendingQueue(context: Context, receiptId: String) {
        synchronized(pendingQueueLock) {
            val pending = loadPendingUploadsInternal(context)
            pending.remove(receiptId)
            savePendingUploadsInternal(context, pending)
        }
    }

    private fun loadPendingUploadsInternal(context: Context): MutableSet<String> {
        return try {
            val file = File(context.filesDir, PENDING_QUEUE_FILE)
            if (!file.exists()) return mutableSetOf()
            val json = JSONArray(file.readText())
            (0 until json.length()).mapTo(mutableSetOf()) { json.getString(it) }
        } catch (e: Exception) {
            Log.w(TAG, "Failed to load pending uploads: ${e.message}")
            mutableSetOf()
        }
    }

    private fun savePendingUploadsInternal(context: Context, pendingIds: Set<String>) {
        try {
            val json = JSONArray()
            pendingIds.forEach { json.put(it) }
            SafeIO.atomicWriteJson(context, PENDING_QUEUE_FILE, json)
        } catch (e: Exception) {
            Log.w(TAG, "Failed to save pending uploads: ${e.message}")
        }
    }

    // ── Receipt File Management ─────────────────────────────────

    fun generateReceiptId(): String = UUID.randomUUID().toString()

    fun getReceiptDir(context: Context): File {
        val dir = File(context.filesDir, RECEIPTS_DIR)
        dir.mkdirs()
        return dir
    }

    fun getThumbDir(context: Context): File {
        val dir = File(context.filesDir, THUMBS_DIR)
        dir.mkdirs()
        return dir
    }

    fun getReceiptFile(context: Context, receiptId: String): File =
        File(getReceiptDir(context), "$receiptId.jpg")

    fun getThumbFile(context: Context, receiptId: String): File =
        File(getThumbDir(context), "$receiptId.jpg")

    fun hasLocalFile(context: Context, receiptId: String): Boolean =
        getReceiptFile(context, receiptId).exists()

    /**
     * Process a photo from URI: downsize, save full + thumbnail, return receiptId.
     * Does NOT encrypt — encryption happens at upload time.
     */
    fun processAndSavePhoto(context: Context, uri: Uri): String? {
        return try {
            val inputStream = context.contentResolver.openInputStream(uri) ?: return null
            val original = BitmapFactory.decodeStream(inputStream)
            inputStream.close()
            if (original == null) return null

            val receiptId = generateReceiptId()
            val resized = resizeBitmap(original, MAX_IMAGE_DIMENSION)

            // Save full-size (92% quality to preserve receipt text readability)
            val fullFile = getReceiptFile(context, receiptId)
            fullFile.outputStream().use { out ->
                resized.compress(Bitmap.CompressFormat.JPEG, 92, out)
            }

            // Save thumbnail (70% is fine for small preview)
            val thumb = resizeBitmap(resized, THUMBNAIL_SIZE)
            getThumbFile(context, receiptId).outputStream().use { out ->
                thumb.compress(Bitmap.CompressFormat.JPEG, 70, out)
            }

            if (resized !== original) original.recycle()
            if (thumb !== resized) thumb.recycle()

            receiptId
        } catch (e: Exception) {
            Log.w(TAG, "Failed to process image: ${e.message}")
            null
        }
    }

    /**
     * Process a photo from camera capture temp file URI.
     */
    fun processAndSaveFromCamera(context: Context, tempUri: Uri): String? =
        processAndSavePhoto(context, tempUri)

    fun loadThumbnail(context: Context, receiptId: String): Bitmap? {
        return try {
            val file = getThumbFile(context, receiptId)
            if (!file.exists()) return null
            BitmapFactory.decodeFile(file.absolutePath)
        } catch (_: Exception) { null }
    }

    fun loadFullImage(context: Context, receiptId: String): Bitmap? {
        return try {
            val file = getReceiptFile(context, receiptId)
            if (!file.exists()) return null
            BitmapFactory.decodeFile(file.absolutePath)
        } catch (_: Exception) { null }
    }

    /**
     * Delete local receipt file + thumbnail.
     */
    fun deleteLocalReceipt(context: Context, receiptId: String) {
        getReceiptFile(context, receiptId).delete()
        getThumbFile(context, receiptId).delete()
    }

    // ── Encryption for Cloud Upload ─────────────────────────────

    /**
     * Read receipt file, encrypt with the sync key, return encrypted bytes.
     */
    fun encryptForUpload(context: Context, receiptId: String, key: ByteArray): ByteArray? {
        return try {
            val file = getReceiptFile(context, receiptId)
            if (!file.exists()) return null
            val plaintext = file.readBytes()
            CryptoHelper.encryptWithKey(plaintext, key)
        } catch (e: Exception) {
            Log.w(TAG, "Failed to encrypt receipt $receiptId: ${e.message}")
            null
        }
    }

    /**
     * Decrypt downloaded receipt data, save to local storage + generate thumbnail.
     */
    fun decryptAndSave(context: Context, receiptId: String, encryptedData: ByteArray, key: ByteArray): Boolean {
        return try {
            val plaintext = CryptoHelper.decryptWithKey(encryptedData, key)

            // Save full-size
            val fullFile = getReceiptFile(context, receiptId)
            fullFile.writeBytes(plaintext)

            // Generate thumbnail from saved image
            val bitmap = BitmapFactory.decodeByteArray(plaintext, 0, plaintext.size)
            if (bitmap != null) {
                val thumb = resizeBitmap(bitmap, THUMBNAIL_SIZE)
                getThumbFile(context, receiptId).outputStream().use { out ->
                    thumb.compress(Bitmap.CompressFormat.JPEG, 70, out)
                }
                if (thumb !== bitmap) bitmap.recycle()
            }

            true
        } catch (e: Exception) {
            Log.w(TAG, "Failed to decrypt receipt $receiptId: ${e.message}")
            false
        }
    }

    // ── Storage Size ────────────────────────────────────────────

    /**
     * Calculate total size of local receipt storage (receipts + thumbnails).
     */
    fun getTotalStorageBytes(context: Context): Long {
        val receiptsSize = getReceiptDir(context).listFiles()?.sumOf { it.length() } ?: 0L
        val thumbsSize = getThumbDir(context).listFiles()?.sumOf { it.length() } ?: 0L
        return receiptsSize + thumbsSize
    }

    // ── Orphan Scan ─────────────────────────────────────────────

    /**
     * Delete local receipt files that are not referenced by any transaction.
     */
    fun cleanOrphans(context: Context, allReceiptIds: Set<String>) {
        val receiptDir = getReceiptDir(context)
        val thumbDir = getThumbDir(context)
        val pending = loadPendingUploads(context)

        receiptDir.listFiles()?.forEach { file ->
            val id = file.nameWithoutExtension
            if (id !in allReceiptIds && id !in pending) {
                file.delete()
                File(thumbDir, file.name).delete()
                Log.d(TAG, "Cleaned orphan receipt: $id")
            }
        }
    }

    // ── Helpers ──────────────────────────────────────────────────

    /**
     * Collect all receiptIds referenced by transactions (non-null slots).
     */
    fun collectAllReceiptIds(transactions: List<com.syncbudget.app.data.Transaction>): Set<String> {
        val ids = mutableSetOf<String>()
        for (t in transactions) {
            t.receiptId1?.let { ids.add(it) }
            t.receiptId2?.let { ids.add(it) }
            t.receiptId3?.let { ids.add(it) }
            t.receiptId4?.let { ids.add(it) }
            t.receiptId5?.let { ids.add(it) }
        }
        return ids
    }

    /**
     * Get the list of receiptIds for a transaction (non-null only).
     */
    fun getReceiptIds(t: com.syncbudget.app.data.Transaction): List<String> {
        return listOfNotNull(t.receiptId1, t.receiptId2, t.receiptId3, t.receiptId4, t.receiptId5)
    }

    /**
     * Find the next empty slot index (1-5) for a transaction, or null if full.
     */
    fun nextEmptySlot(t: com.syncbudget.app.data.Transaction): Int? {
        if (t.receiptId1 == null) return 1
        if (t.receiptId2 == null) return 2
        if (t.receiptId3 == null) return 3
        if (t.receiptId4 == null) return 4
        if (t.receiptId5 == null) return 5
        return null
    }

    private fun resizeBitmap(bitmap: Bitmap, maxDimension: Int): Bitmap {
        val width = bitmap.width
        val height = bitmap.height
        if (width <= maxDimension && height <= maxDimension) return bitmap
        val scale = maxDimension.toFloat() / maxOf(width, height)
        val newWidth = (width * scale).toInt()
        val newHeight = (height * scale).toInt()
        return Bitmap.createScaledBitmap(bitmap, newWidth, newHeight, true)
    }
}
