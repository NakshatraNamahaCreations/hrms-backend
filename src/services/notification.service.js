const Notification = require('../models/Notification');
const User = require('../models/User');

// ---- Channel stubs (wire real providers here later) -----------------------
// Accepts plain text (body) and/or rich html (payslip emails). With no SMTP_*
// env configured there is no transport, so the send is logged as a stub.
const sendEmail = async ({ to, subject, body, html }) => {
  const preview = body != null ? String(body) : String(html || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  // eslint-disable-next-line no-console
  console.log(`[email stub]${process.env.SMTP_HOST ? '' : ' (no SMTP env)'} to=${to} subject="${subject}" ${html ? 'html' : 'body'}="${preview.slice(0, 200)}"`);
  return { sent: true, channel: 'email', stub: true };
};

const sendSMS = async ({ to, message }) => {
  // eslint-disable-next-line no-console
  console.log(`[sms stub] to=${to} message="${String(message).slice(0, 120)}"`);
  return { sent: true, channel: 'sms', stub: true };
};

const sendWhatsApp = async ({ to, message }) => {
  // eslint-disable-next-line no-console
  console.log(`[whatsapp stub] to=${to} message="${String(message).slice(0, 120)}"`);
  return { sent: true, channel: 'whatsapp', stub: true };
};

const sendPush = async ({ fcmToken, title, message }) => {
  // eslint-disable-next-line no-console
  console.log(`[push stub] token=${fcmToken ? 'set' : 'none'} title="${title}" message="${String(message).slice(0, 120)}"`);
  return { sent: true, channel: 'push', stub: true };
};

/**
 * Creates in-app Notification documents (and fires stub channels when requested).
 * @param {object} opts { companyId, userId | userIds[], title, message, type, link, meta, channels: ['email','sms','whatsapp','push'] }
 */
const notify = async ({
  companyId = null,
  userId,
  userIds,
  title,
  message,
  type = 'general',
  link = null,
  meta = {},
  channels = [],
}) => {
  const targets = (userIds || (userId ? [userId] : [])).filter(Boolean);
  if (!targets.length) return [];

  // Clamp to the schema's backstop maxlengths so internal callers that embed
  // user-provided text (reasons, titles, notes) can never fail validation.
  const safeTitle = String(title ?? '').slice(0, Notification.MAX_TITLE_LENGTH);
  const safeMessage = String(message ?? '').slice(0, Notification.MAX_MESSAGE_LENGTH);

  const docs = await Notification.insertMany(
    targets.map((uid) => ({ companyId, userId: uid, title: safeTitle, message: safeMessage, type, link, meta }))
  );

  if (channels.length) {
    const users = await User.find({ _id: { $in: targets } }).select('email fcmToken').lean();
    await Promise.all(
      users.flatMap((u) => {
        const jobs = [];
        if (channels.includes('email') && u.email) jobs.push(sendEmail({ to: u.email, subject: safeTitle, body: safeMessage }));
        if (channels.includes('sms')) jobs.push(sendSMS({ to: u.email, message: safeMessage }));
        if (channels.includes('whatsapp')) jobs.push(sendWhatsApp({ to: u.email, message: safeMessage }));
        if (channels.includes('push')) jobs.push(sendPush({ fcmToken: u.fcmToken, title: safeTitle, message: safeMessage }));
        return jobs;
      })
    );
  }
  return docs;
};

// Notify all users of given roles within a company.
const notifyRoles = async ({ companyId, roles, title, message, type, link, meta, channels }) => {
  const users = await User.find({ companyId, role: { $in: roles }, isActive: true }).select('_id').lean();
  return notify({ companyId, userIds: users.map((u) => u._id), title, message, type, link, meta, channels });
};

module.exports = { notify, notifyRoles, sendEmail, sendSMS, sendWhatsApp, sendPush };
