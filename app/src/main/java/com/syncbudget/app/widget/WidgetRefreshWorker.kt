package com.syncbudget.app.widget

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import com.syncbudget.app.data.BudgetCalculator
import com.syncbudget.app.data.IncomeMode
import com.syncbudget.app.data.IncomeSourceRepository
import com.syncbudget.app.data.RecurringExpenseRepository
import com.syncbudget.app.data.TransactionRepository
import com.syncbudget.app.data.getDoubleCompat
import com.syncbudget.app.data.sync.PeriodLedgerRepository
import com.syncbudget.app.data.sync.active
import java.time.LocalDate
import java.util.concurrent.TimeUnit

/**
 * Periodic worker that pulls remote changes and recomputes availableCash.
 * Runs every 30 minutes even when the app is not open, ensuring the
 * widget reflects transactions from other devices and period resets.
 */
class WidgetRefreshWorker(
    appContext: Context,
    workerParams: WorkerParameters
) : CoroutineWorker(appContext, workerParams) {

    override suspend fun doWork(): Result {
        return try {
            // Pull remote changes if device is in a sync group
            pullRemoteChanges()

            // Recompute cash from (possibly updated) local data
            recomputeAndUpdateWidget()

            Result.success()
        } catch (e: Exception) {
            android.util.Log.w("WidgetRefresh", "Refresh failed: ${e.message}")
            Result.success()  // don't retry, wait for next scheduled run
        }
    }

    /** No-op: Firestore-native listeners handle remote changes in real time. */
    private suspend fun pullRemoteChanges() {
        // With Firestore-native sync, real-time listeners handle remote
        // changes. This worker only needs to recompute cash and update
        // the widget (below).
    }

    private fun recomputeAndUpdateWidget() {
        val prefs = applicationContext.getSharedPreferences("app_prefs", Context.MODE_PRIVATE)
        val budgetStartDate = prefs.getString("budgetStartDate", null)?.let {
            try { LocalDate.parse(it) } catch (_: Exception) { null }
        } ?: return

        val periodLedger = PeriodLedgerRepository.load(applicationContext)
        val transactions = TransactionRepository.load(applicationContext)
        val recurringExpenses = RecurringExpenseRepository.load(applicationContext)
        val incomeSources = IncomeSourceRepository.load(applicationContext)

        val incomeMode = try {
            IncomeMode.valueOf(prefs.getString("incomeMode", null) ?: "FIXED")
        } catch (_: Exception) { IncomeMode.FIXED }

        val activeTxns = transactions.active
        val activeRE = recurringExpenses.active
        val activeIS = incomeSources.active

        val cash = BudgetCalculator.recomputeAvailableCash(
            budgetStartDate, periodLedger, activeTxns, activeRE,
            incomeMode, activeIS
        )

        val currentCash = prefs.getDoubleCompat("availableCash")
        if (cash != currentCash) {
            prefs.edit().putString("availableCash", cash.toString()).apply()
        }

        BudgetWidgetProvider.updateAllWidgets(applicationContext)
    }

    companion object {
        private const val WORK_NAME = "widget_refresh"

        fun schedule(context: Context) {
            val request = PeriodicWorkRequestBuilder<WidgetRefreshWorker>(
                30, TimeUnit.MINUTES
            ).build()

            WorkManager.getInstance(context).enqueueUniquePeriodicWork(
                WORK_NAME,
                ExistingPeriodicWorkPolicy.KEEP,
                request
            )
        }

        /** Trigger an immediate one-shot refresh (e.g., at budget reset time). */
        fun runOnce(context: Context) {
            val request = androidx.work.OneTimeWorkRequestBuilder<WidgetRefreshWorker>().build()
            WorkManager.getInstance(context).enqueue(request)
        }
    }
}
