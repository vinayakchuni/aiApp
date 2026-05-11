import { Resend } from 'resend';
import type { StructuredReport } from './research';

let resend: Resend;

function getResendClient() {
  if (!resend) {
    resend = new Resend(process.env.RESEND_API_KEY);
  }
  return resend;
}

const FROM_EMAIL = process.env.FROM_EMAIL || 'noreply@example.com';
const APP_URL = process.env.FRONTEND_URL || 'http://localhost:3000';

export async function sendVerificationEmail({ email, token }: { email: string; token: string }) {
  const verifyUrl = `${APP_URL}/verify-email?token=${token}`;

  await getResendClient().emails.send({
    from: FROM_EMAIL,
    to: email,
    subject: 'Verify your email address',
    text: `Welcome! Please verify your email address by clicking the link below:\n\n${verifyUrl}\n\nThis link will expire in 24 hours.\n\nIf you did not create an account, you can safely ignore this email.`,
  });
}

export async function sendPasswordResetEmail({ email, token }: { email: string; token: string }) {
  const resetUrl = `${APP_URL}/reset-password?token=${token}`;

  await getResendClient().emails.send({
    from: FROM_EMAIL,
    to: email,
    subject: 'Reset your password',
    text: `You requested a password reset. Click the link below to set a new password:\n\n${resetUrl}\n\nThis link will expire in 1 hour.\n\nIf you did not request this, you can safely ignore this email.`,
  });
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function renderResearchReportHtml({
  topic,
  report,
  conversationUrl,
}: {
  topic: string;
  report: StructuredReport;
  conversationUrl: string;
}): string {
  const findings = report.keyFindings
    .map((f) => `<li style="margin-bottom:6px;">${escapeHtml(f)}</li>`)
    .join('');
  const analysisParas = report.detailedAnalysis
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map(
      (p) =>
        `<p style="margin:0 0 12px 0;white-space:pre-wrap;">${escapeHtml(p)}</p>`,
    )
    .join('');
  const sources = report.sources
    .map((s) => {
      const verifiedBadge =
        s.reliability === 'verified'
          ? ` <span style="display:inline-block;background:#dcfce7;color:#166534;padding:1px 6px;border-radius:4px;font-size:10px;font-weight:600;text-transform:uppercase;">verified</span>`
          : '';
      return `<li style="margin-bottom:6px;">[${s.index}] <a href="${escapeHtml(
        s.url,
      )}" style="color:#7c3aed;text-decoration:none;">${escapeHtml(s.title || s.url)}</a>${verifiedBadge}</li>`;
    })
    .join('');
  const fc = report.methodology.factCheckSummary;
  const queries = report.methodology.queries
    .map((q) => `<li style="margin-bottom:4px;">${escapeHtml(q)}</li>`)
    .join('');
  const finalScoresBlock = report.methodology.finalScores
    ? Object.entries(report.methodology.finalScores)
        .map(
          ([k, v]) =>
            `<li style="margin-bottom:4px;">${escapeHtml(k.replace(/_/g, ' '))}: <strong>${v}</strong></li>`,
        )
        .join('')
    : '';

  return `<!doctype html>
<html><body style="margin:0;padding:0;background:#f5f3ff;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif;color:#111827;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f3ff;padding:24px 0;">
    <tr><td align="center">
      <table role="presentation" width="640" cellpadding="0" cellspacing="0" style="max-width:640px;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.04);">
        <tr><td style="background:#7c3aed;padding:20px 28px;color:#ffffff;">
          <div style="font-size:11px;letter-spacing:0.08em;text-transform:uppercase;opacity:0.9;">Research Report</div>
          <h1 style="margin:6px 0 0 0;font-size:22px;font-weight:600;">${escapeHtml(topic)}</h1>
        </td></tr>
        <tr><td style="padding:24px 28px;">
          <h2 style="margin:0 0 8px 0;font-size:13px;text-transform:uppercase;letter-spacing:0.06em;color:#6b21a8;">Executive Summary</h2>
          <p style="margin:0 0 20px 0;line-height:1.6;white-space:pre-wrap;">${escapeHtml(report.executiveSummary)}</p>

          <h2 style="margin:0 0 8px 0;font-size:13px;text-transform:uppercase;letter-spacing:0.06em;color:#6b21a8;">Key Findings</h2>
          <ul style="margin:0 0 20px 20px;padding:0;line-height:1.6;">${findings}</ul>

          <h2 style="margin:0 0 8px 0;font-size:13px;text-transform:uppercase;letter-spacing:0.06em;color:#6b21a8;">Detailed Analysis</h2>
          <div style="line-height:1.6;margin-bottom:20px;">${analysisParas}</div>

          <h2 style="margin:0 0 8px 0;font-size:13px;text-transform:uppercase;letter-spacing:0.06em;color:#6b21a8;">Sources (${report.sources.length})</h2>
          <ol style="margin:0 0 20px 20px;padding:0;line-height:1.6;">${sources}</ol>

          <h2 style="margin:0 0 8px 0;font-size:13px;text-transform:uppercase;letter-spacing:0.06em;color:#6b21a8;">Methodology</h2>
          <div style="font-size:13px;line-height:1.6;color:#374151;">
            <div style="margin-bottom:8px;"><strong>Search queries (${report.methodology.queries.length}):</strong></div>
            <ul style="margin:0 0 12px 20px;padding:0;">${queries || '<li>(none)</li>'}</ul>
            <div style="margin-bottom:8px;"><strong>Iterations:</strong> ${report.methodology.iterationCount}</div>
            ${finalScoresBlock ? `<div style="margin-bottom:8px;"><strong>Final scores (1-5):</strong></div><ul style="margin:0 0 12px 20px;padding:0;">${finalScoresBlock}</ul>` : ''}
            <div style="margin-bottom:8px;"><strong>Fact check:</strong> ${fc.verifiedClaims} verified / ${fc.unverifiedClaims} unverified / ${fc.notCheckedClaims} not checked (of ${fc.totalClaimsExtracted} total)</div>
          </div>

          <div style="margin-top:28px;text-align:center;">
            <a href="${escapeHtml(conversationUrl)}" style="display:inline-block;background:#7c3aed;color:#ffffff;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:600;font-size:14px;">Open conversation</a>
          </div>
        </td></tr>
        <tr><td style="padding:16px 28px 24px;color:#6b7280;font-size:11px;text-align:center;">
          You're receiving this because your research task completed. Reply to this conversation in the app to ask follow-up questions.
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

export function renderResearchReportText({
  topic,
  report,
  conversationUrl,
}: {
  topic: string;
  report: StructuredReport;
  conversationUrl: string;
}): string {
  const findings = report.keyFindings.map((f) => `- ${f}`).join('\n');
  const sources = report.sources
    .map(
      (s) =>
        `[${s.index}] ${s.title || s.url} — ${s.url}${s.reliability === 'verified' ? ' (verified)' : ''}`,
    )
    .join('\n');
  return `Research report: ${topic}

EXECUTIVE SUMMARY
${report.executiveSummary}

KEY FINDINGS
${findings}

DETAILED ANALYSIS
${report.detailedAnalysis}

SOURCES
${sources}

Open the conversation: ${conversationUrl}
`;
}

export async function sendResearchCompleteEmail({
  email,
  conversationId,
  topic,
  report,
}: {
  email: string;
  conversationId: string;
  topic: string;
  report: StructuredReport;
}) {
  const conversationUrl = `${APP_URL}/?conversation=${encodeURIComponent(conversationId)}`;
  const html = renderResearchReportHtml({ topic, report, conversationUrl });
  const text = renderResearchReportText({ topic, report, conversationUrl });
  const subject = `Research ready: ${topic.length > 80 ? `${topic.slice(0, 77)}...` : topic}`;

  await getResendClient().emails.send({
    from: FROM_EMAIL,
    to: email,
    subject,
    html,
    text,
  });
}
