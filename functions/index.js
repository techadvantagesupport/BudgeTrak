const { onDocumentDeleted } = require('firebase-functions/v2/firestore');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { getDatabase } = require('firebase-admin/database');
const { getStorage } = require('firebase-admin/storage');

initializeApp();

/**
 * Cascade cleanup when a group document is deleted (by TTL or manually).
 *
 * Firestore TTL deletes the group doc after 90 days of inactivity, but does
 * NOT auto-delete subcollections, RTDB presence, or Cloud Storage files.
 * This function handles all of that.
 */
exports.cleanupGroupData = onDocumentDeleted('groups/{groupId}', async (event) => {
  const groupId = event.params.groupId;
  const db = getFirestore();
  const groupRef = db.collection('groups').doc(groupId);

  // Delete all Firestore subcollections (paginated for large collections)
  const subcollections = [
    'transactions', 'recurringExpenses', 'incomeSources',
    'savingsGoals', 'amortizationEntries', 'categories',
    'periodLedger', 'sharedSettings',
    'devices', 'members', 'imageLedger', 'adminClaim',
    'deltas', 'snapshots'  // Legacy CRDT (may exist on old groups)
  ];

  for (const sub of subcollections) {
    let docs;
    do {
      docs = await groupRef.collection(sub).listDocuments({ pageSize: 500 });
      if (docs.length > 0) {
        const batch = db.batch();
        for (const doc of docs) {
          batch.delete(doc);
        }
        await batch.commit();
      }
    } while (docs.length >= 500);
  }

  // Delete RTDB presence nodes for entire group
  try {
    await getDatabase().ref(`groups/${groupId}`).remove();
  } catch (e) {
    console.warn(`RTDB cleanup failed for ${groupId}: ${e.message}`);
  }

  // Delete Cloud Storage files (receipts + snapshot archive)
  try {
    const bucket = getStorage().bucket();
    const [files] = await bucket.getFiles({ prefix: `groups/${groupId}/` });
    const deletePromises = files.map(file => file.delete().catch(() => {}));
    await Promise.all(deletePromises);
  } catch (e) {
    console.warn(`Storage cleanup failed for ${groupId}: ${e.message}`);
  }

  console.log(`Cleaned up group ${groupId}: subcollections, RTDB, and Storage`);
});
