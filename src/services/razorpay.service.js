const crypto = require('crypto');

/**
 * Razorpay wrapper. When RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET are absent the
 * service runs in MOCK MODE: orders get a mock id and signature verification
 * always succeeds (intended for local development).
 */

const isMockMode = () => !process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET;

/**
 * Creates a Razorpay order. amount is in INR (rupees) — converted to paise.
 */
const createOrder = async ({ amount, currency = 'INR', receipt, notes = {} }) => {
  if (isMockMode()) {
    return {
      id: `order_mock_${Date.now()}_${Math.round(Math.random() * 1e6)}`,
      amount: Math.round(amount * 100),
      currency,
      receipt,
      notes,
      status: 'created',
      mock: true,
    };
  }

  const auth = Buffer.from(`${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`).toString('base64');
  const res = await fetch('https://api.razorpay.com/v1/orders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Basic ${auth}` },
    body: JSON.stringify({ amount: Math.round(amount * 100), currency, receipt, notes }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Razorpay order creation failed: ${res.status} ${text}`);
  }
  const order = await res.json();
  order.mock = false;
  return order;
};

/**
 * Verifies the Razorpay payment signature. Always true in mock mode.
 */
const verifySignature = ({ orderId, paymentId, signature }) => {
  if (isMockMode()) return true;
  const expected = crypto
    .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
    .update(`${orderId}|${paymentId}`)
    .digest('hex');
  return expected === signature;
};

module.exports = { createOrder, verifySignature, isMockMode };
