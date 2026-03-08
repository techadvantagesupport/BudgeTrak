package com.syncbudget.app.data

import android.content.SharedPreferences

/** Read a numeric pref that may have been stored as Float, Double, Int, Long, or String. */
fun SharedPreferences.getDoubleCompat(key: String, default: Double = 0.0): Double {
    return try {
        getString(key, null)?.toDoubleOrNull() ?: default
    } catch (_: ClassCastException) {
        try { getFloat(key, default.toFloat()).toDouble() }
        catch (_: ClassCastException) {
            try { getLong(key, default.toLong()).toDouble() }
            catch (_: ClassCastException) {
                try { getInt(key, default.toInt()).toDouble() }
                catch (_: Exception) { default }
            }
        }
    }
}
