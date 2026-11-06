const Loan = require('../models/Loan');

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/**
 * Atomically posts one EMI ledger entry against a disbursed loan (v1.6).
 *
 * `loan` is the caller's snapshot (a loaded document); the push and the
 * counter bump succeed only while the stored document still matches that
 * snapshot (status/paidEmis/balance). A concurrent writer — e.g. a manual
 * POST /loans/:id/payments racing PATCH /payroll/:id/mark-paid — makes the
 * update a no-op and this returns null so the caller can retry on a fresh
 * read or report a conflict. This guarantees ledger seq numbers are never
 * duplicated and balance decrements are never lost.
 *
 * The balance round/clamp and the auto-close at zero run as a follow-up
 * update guarded on the paidEmis value just written, so a later writer's
 * state is never overwritten.
 *
 * Returns the updated loan document (status/balance normalized) or null.
 */
const postLoanPayment = async (loan, entry) => {
  const amount = round2(entry.amount);
  const updated = await Loan.findOneAndUpdate(
    { _id: loan._id, status: 'disbursed', paidEmis: loan.paidEmis, balance: loan.balance },
    {
      $push: { payments: { ...entry, amount, seq: (loan.paidEmis || 0) + 1 } },
      $inc: { paidEmis: 1, balance: -amount },
    },
    { new: true }
  );
  if (!updated) return null;

  // normalize the $inc float result and auto-close once fully repaid
  const balance = Math.max(0, round2(updated.balance));
  const closing = balance === 0;
  if (closing || balance !== updated.balance) {
    const set = { balance };
    if (closing) {
      set.status = 'closed';
      set.closedAt = new Date();
    }
    await Loan.updateOne({ _id: updated._id, paidEmis: updated.paidEmis }, { $set: set });
    updated.balance = balance;
    if (closing) {
      updated.status = set.status;
      updated.closedAt = set.closedAt;
    }
  }
  return updated;
};

module.exports = { postLoanPayment };
