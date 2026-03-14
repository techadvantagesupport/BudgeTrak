package com.syncbudget.app.data.sync

import android.content.Context
import android.content.SharedPreferences
import android.util.Log
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKeys

/**
 * Provides encrypted SharedPreferences for sensitive sync data
 * (encryption keys).  Migrates from plain prefs on first access.
 */
object SecurePrefs {

    private const val TAG = "SecurePrefs"
    private const val ENCRYPTED_PREFS_NAME = "sync_engine_secure"
    private const val PLAIN_PREFS_NAME = "sync_engine"

    private var cached: SharedPreferences? = null

    /**
     * Get encrypted SharedPreferences, creating if needed.
     * Falls back to plain prefs if encryption is unavailable
     * (e.g., older devices without KeyStore support).
     */
    @Synchronized
    fun get(context: Context): SharedPreferences {
        cached?.let { return it }
        val prefs = try {
            val masterKeyAlias = MasterKeys.getOrCreate(MasterKeys.AES256_GCM_SPEC)
            EncryptedSharedPreferences.create(
                ENCRYPTED_PREFS_NAME,
                masterKeyAlias,
                context,
                EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
            )
        } catch (e: Exception) {
            Log.w(TAG, "EncryptedSharedPreferences unavailable, using plain prefs: ${e.message}")
            context.getSharedPreferences(PLAIN_PREFS_NAME, Context.MODE_PRIVATE)
        }

        // One-time migration: move encryptionKey from plain to encrypted prefs
        migrateFromPlain(context, prefs)

        cached = prefs
        return prefs
    }

    private fun migrateFromPlain(context: Context, securePrefs: SharedPreferences) {
        val plainPrefs = context.getSharedPreferences(PLAIN_PREFS_NAME, Context.MODE_PRIVATE)
        val key = plainPrefs.getString("encryptionKey", null)
        if (key != null && securePrefs.getString("encryptionKey", null) == null) {
            securePrefs.edit().putString("encryptionKey", key).commit()
            plainPrefs.edit().remove("encryptionKey").commit()
            Log.i(TAG, "Migrated encryptionKey to encrypted storage")
        }
    }
}
