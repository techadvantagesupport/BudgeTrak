package com.syncbudget.app

import android.app.Application
import android.util.Log

class BudgeTrakApplication : Application() {
    override fun onCreate() {
        super.onCreate()

        // Install App Check provider factory early — before any Firebase service calls.
        // Must be in Application.onCreate() (not ViewModel) so it runs even when
        // the process is started by WorkManager without a foreground Activity.
        try {
            val appCheck = com.google.firebase.appcheck.FirebaseAppCheck.getInstance()
            appCheck.installAppCheckProviderFactory(
                com.google.firebase.appcheck.playintegrity.PlayIntegrityAppCheckProviderFactory.getInstance()
            )
            // Debug: log token lifecycle events
            appCheck.addAppCheckListener { token ->
                val expiresIn = (token.expireTimeMillis - System.currentTimeMillis()) / 1000
                Log.i("AppCheck", "Token refreshed: expires in ${expiresIn}s (${expiresIn / 60}m)")
            }
        } catch (e: Exception) {
            Log.w("AppCheck", "App Check init failed: ${e.message}")
        }
        // Debug: log auth state changes
        try {
            com.google.firebase.auth.FirebaseAuth.getInstance()
                .addAuthStateListener { auth ->
                    val user = auth.currentUser
                    Log.i("AuthState", "Auth state: uid=${user?.uid ?: "null"} anon=${user?.isAnonymous} provider=${user?.providerId}")
                }
        } catch (e: Exception) {
            Log.w("AuthState", "Auth listener failed: ${e.message}")
        }
    }
}
