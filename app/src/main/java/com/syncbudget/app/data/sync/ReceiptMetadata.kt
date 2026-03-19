package com.syncbudget.app.data.sync

data class ReceiptMetadata(
    val receiptId: String,
    val transactionId: Int?,       // null if not yet linked
    val localPath: String,
    val uploadedToCloud: Boolean,
    val capturedAt: Long,
    val downloadRetryCount: Int = 0
)
