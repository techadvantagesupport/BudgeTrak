package com.syncbudget.app.data.sync

import android.content.Context
import android.content.SharedPreferences
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.locks.ReentrantLock

class LamportClock(context: Context) {

    companion object {
        /** Process-wide lock so all LamportClock instances are serialized. */
        private val lock = ReentrantLock()
    }

    private val prefs: SharedPreferences =
        context.getSharedPreferences("lamport_clock", Context.MODE_PRIVATE)

    private val counter: AtomicLong

    init {
        // Read prefs under the lock to avoid racing with another instance's tick/merge
        lock.lock()
        try {
            val prefsVal = prefs.getLong("clock", 0L)
            counter = AtomicLong(prefsVal)
        } finally {
            lock.unlock()
        }
    }

    val value: Long
        get() {
            lock.lock()
            try {
                val prefsVal = prefs.getLong("clock", 0L)
                val current = maxOf(counter.get(), prefsVal)
                counter.set(current)
                return current
            } finally {
                lock.unlock()
            }
        }

    fun tick(): Long {
        lock.lock()
        try {
            val prefsVal = prefs.getLong("clock", 0L)
            val current = maxOf(counter.get(), prefsVal)
            val newVal = current + 1
            counter.set(newVal)
            prefs.edit().putLong("clock", newVal).commit()
            return newVal
        } finally {
            lock.unlock()
        }
    }

    fun merge(remoteClock: Long) {
        lock.lock()
        try {
            val prefsVal = prefs.getLong("clock", 0L)
            val current = maxOf(counter.get(), prefsVal)
            val newVal = maxOf(current, remoteClock) + 1
            counter.set(newVal)
            prefs.edit().putLong("clock", newVal).commit()
        } finally {
            lock.unlock()
        }
    }
}
