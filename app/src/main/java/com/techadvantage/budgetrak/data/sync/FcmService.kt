package com.techadvantage.budgetrak.data.sync

import android.content.Context
import android.util.Log
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

class FcmService : FirebaseMessagingService() {
    companion object {
        private const val TAG = "FcmService"
    }

    override fun onNewToken(token: String) {
        Log.d(TAG, "New FCM token")
        getSharedPreferences("fcm_prefs", Context.MODE_PRIVATE)
            .edit().putString("fcm_token", token)
            .putBoolean("token_needs_upload", true).apply()
    }

    override fun onMessageReceived(message: RemoteMessage) {
        val type = message.data["type"] ?: return
        Log.d(TAG, "FCM message received: type=$type")
        com.techadvantage.budgetrak.BudgeTrakApplication.syncEvent("FCM received: type=$type")
        when (type) {
            "debug_request" -> handleDebugRequest()
            "sync_push", "heartbeat" -> handleWakeForSync()
        }
    }

    /** Debug-build-only: trigger an immediate dump upload for remote diagnostics. */
    private fun handleDebugRequest() {
        if (!com.techadvantage.budgetrak.BuildConfig.DEBUG) return
        try {
            getSharedPreferences("fcm_prefs", Context.MODE_PRIVATE)
                .edit().putBoolean("fcm_debug_requested", true).apply()
            val request = androidx.work.OneTimeWorkRequestBuilder<DebugDumpWorker>().build()
            androidx.work.WorkManager.getInstance(applicationContext).enqueue(request)
            Log.d(TAG, "Triggered one-shot DebugDumpWorker")
        } catch (e: Exception) {
            Log.e(TAG, "Failed to trigger debug sync: ${e.message}")
        }
    }

    /**
     * On `sync_push` (another device wrote data) or `heartbeat` (scheduler saw
     * this device's RTDB lastSeen go stale), enqueue a one-shot sync.
     * BackgroundSyncWorker.runOnce is expedited on Android 12+ and deduped
     * so bursts collapse into a single run.
     */
    private fun handleWakeForSync() {
        try {
            BackgroundSyncWorker.runOnce(applicationContext)
        } catch (e: Exception) {
            Log.e(TAG, "Failed to enqueue sync runOnce: ${e.message}")
        }
    }
}
