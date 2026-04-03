package com.syncbudget.app

import android.app.Application
import android.util.Log

class BudgeTrakApplication : Application() {

    companion object {
        /** Persistent file-based log for token/auth events (survives logcat rotation). */
        fun tokenLog(msg: String) {
            Log.i("TokenDebug", msg)
            try {
                val dir = com.syncbudget.app.data.BackupManager.getSupportDir()
                val file = java.io.File(dir, "token_log.txt")
                if (file.exists() && file.length() > 100_000) file.writeText("")
                val ts = java.time.LocalDateTime.now().toString()
                file.appendText("[$ts] $msg\n")
            } catch (_: Exception) {}
        }
    }

    override fun onCreate() {
        super.onCreate()

        tokenLog("=== Process started ===")

        // Install App Check provider factory early — before any Firebase service calls.
        // Must be in Application.onCreate() (not ViewModel) so it runs even when
        // the process is started by WorkManager without a foreground Activity.
        try {
            val appCheck = com.google.firebase.appcheck.FirebaseAppCheck.getInstance()
            appCheck.installAppCheckProviderFactory(
                com.google.firebase.appcheck.playintegrity.PlayIntegrityAppCheckProviderFactory.getInstance()
            )
            appCheck.addAppCheckListener { token ->
                val expiresIn = (token.expireTimeMillis - System.currentTimeMillis()) / 1000
                tokenLog("AppCheck token refreshed: expires in ${expiresIn}s (${expiresIn / 60}m)")
            }
        } catch (e: Exception) {
            tokenLog("AppCheck init failed: ${e.message}")
        }
        try {
            com.google.firebase.auth.FirebaseAuth.getInstance()
                .addAuthStateListener { auth ->
                    val user = auth.currentUser
                    tokenLog("Auth state: uid=${user?.uid ?: "null"} anon=${user?.isAnonymous}")
                }
        } catch (e: Exception) {
            tokenLog("Auth listener failed: ${e.message}")
        }
    }
}
