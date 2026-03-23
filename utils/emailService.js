const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.gmail.com',
  port: parseInt(process.env.SMTP_PORT) || 587,
  secure: false,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASSWORD,
  },
  connectionTimeout: 10000,
  greetingTimeout: 10000,
  socketTimeout: 10000,
});

async function sendVerificationEmail(toEmail, firstName, token) {
  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
  const verifyLink = `${frontendUrl}/verify-email?token=${token}`;

  await transporter.sendMail({
    from: `"The Party Goers PH" <${process.env.SMTP_USER}>`,
    to: toEmail,
    subject: 'Confirm your Party Goers account',
    html: `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Verify your email</title>
</head>
<body style="margin:0;padding:0;background:#0A0A0A;font-family:'DM Sans',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0A0A0A;padding:40px 0;">
    <tr>
      <td align="center">
        <table width="560" cellpadding="0" cellspacing="0" style="background:#111111;border-radius:16px;border:1px solid rgba(255,255,255,0.06);overflow:hidden;max-width:560px;width:100%;">
          <!-- Header -->
          <tr>
            <td style="background:linear-gradient(135deg,#1a0000 0%,#111111 100%);padding:36px 40px 28px;border-bottom:1px solid rgba(204,0,0,0.2);">
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td>
                    <span style="font-size:1.4rem;font-weight:800;color:#ffffff;letter-spacing:-0.5px;">Party<span style="color:#CC0000;">Goers</span> PH</span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <!-- Body -->
          <tr>
            <td style="padding:36px 40px;">
              <p style="margin:0 0 8px;font-size:0.78rem;font-weight:700;text-transform:uppercase;letter-spacing:2px;color:#CC0000;">Verify Your Account</p>
              <h1 style="margin:0 0 16px;font-size:1.6rem;font-weight:800;color:#ffffff;line-height:1.2;">Hey ${firstName}, you're almost in! 🎉</h1>
              <p style="margin:0 0 28px;font-size:0.95rem;color:#888888;line-height:1.7;">
                Thanks for joining The Party Goers PH. Click the button below to confirm your email address and activate your account.
              </p>
              <!-- CTA Button -->
              <table cellpadding="0" cellspacing="0" width="100%">
                <tr>
                  <td align="center" style="padding-bottom:28px;">
                    <a href="${verifyLink}" target="_blank"
                       style="display:inline-block;padding:14px 36px;background:#CC0000;color:#ffffff;text-decoration:none;border-radius:100px;font-size:0.95rem;font-weight:700;letter-spacing:0.5px;">
                      Verify My Email
                    </a>
                  </td>
                </tr>
              </table>
              <!-- Fallback link -->
              <p style="margin:0 0 24px;font-size:0.78rem;color:#555555;line-height:1.6;">
                If the button doesn't work, copy and paste this link into your browser:<br/>
                <a href="${verifyLink}" style="color:#CC0000;word-break:break-all;">${verifyLink}</a>
              </p>
              <!-- Note -->
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="background:#161616;border:1px solid rgba(255,255,255,0.06);border-left:3px solid #CC0000;border-radius:8px;padding:12px 16px;">
                    <p style="margin:0;font-size:0.78rem;color:#888888;line-height:1.6;">
                      ⏱️ This link expires in <strong style="color:#ffffff;">24 hours</strong>. If you did not create an account, you can safely ignore this email.
                    </p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <!-- Footer -->
          <tr>
            <td style="padding:20px 40px;border-top:1px solid rgba(255,255,255,0.06);">
              <p style="margin:0;font-size:0.72rem;color:#444444;text-align:center;">
                © ${new Date().getFullYear()} The Party Goers PH · Cavite, Philippines<br/>
                You're receiving this because you registered on our platform.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
    `.trim(),
  });
}

async function sendBarApprovalEmail(toEmail, ownerName, businessName) {
  const loginUrl = process.env.BAR_OWNER_URL || 'https://barowner.thepartygoersph.com/login';

  await transporter.sendMail({
    from: `"The Party Goers PH" <${process.env.SMTP_USER}>`,
    to: toEmail,
    subject: '🎉 Your Business Registration is Approved!',
    html: `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Registration Approved</title>
</head>
<body style="margin:0;padding:0;background:#0A0A0A;font-family:'DM Sans',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0A0A0A;padding:40px 0;">
    <tr>
      <td align="center">
        <table width="560" cellpadding="0" cellspacing="0" style="background:#111111;border-radius:16px;border:1px solid rgba(255,255,255,0.06);overflow:hidden;max-width:560px;width:100%;">
          <!-- Header -->
          <tr>
            <td style="background:linear-gradient(135deg,#1a0000 0%,#111111 100%);padding:36px 40px 28px;border-bottom:1px solid rgba(204,0,0,0.2);">
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td>
                    <span style="font-size:1.4rem;font-weight:800;color:#ffffff;letter-spacing:-0.5px;">Party<span style="color:#CC0000;">Goers</span> PH</span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <!-- Body -->
          <tr>
            <td style="padding:36px 40px;">
              <p style="margin:0 0 8px;font-size:0.78rem;font-weight:700;text-transform:uppercase;letter-spacing:2px;color:#22c55e;">✓ Registration Approved</p>
              <h1 style="margin:0 0 16px;font-size:1.6rem;font-weight:800;color:#ffffff;line-height:1.2;">Congratulations, ${ownerName}! 🎉</h1>
              <p style="margin:0 0 28px;font-size:0.95rem;color:#888888;line-height:1.7;">
                Great news! Your business registration for <strong style="color:#ffffff;">${businessName}</strong> has been approved by our team.
              </p>
              <p style="margin:0 0 28px;font-size:0.95rem;color:#888888;line-height:1.7;">
                You can now access the <strong style="color:#ffffff;">Bar Operations Platform</strong> to manage your business, events, promotions, and more.
              </p>
              <!-- CTA Button -->
              <table cellpadding="0" cellspacing="0" width="100%">
                <tr>
                  <td align="center" style="padding-bottom:28px;">
                    <a href="${loginUrl}" target="_blank"
                       style="display:inline-block;padding:14px 36px;background:#CC0000;color:#ffffff;text-decoration:none;border-radius:100px;font-size:0.95rem;font-weight:700;letter-spacing:0.5px;">
                      Login to Bar Platform
                    </a>
                  </td>
                </tr>
              </table>
              <!-- Login Details -->
              <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;">
                <tr>
                  <td style="background:#161616;border:1px solid rgba(255,255,255,0.06);border-left:3px solid #22c55e;border-radius:8px;padding:16px;">
                    <p style="margin:0 0 12px;font-size:0.85rem;font-weight:700;color:#ffffff;">📧 Your Login Credentials</p>
                    <p style="margin:0 0 8px;font-size:0.78rem;color:#888888;line-height:1.6;">
                      <strong style="color:#ffffff;">Email:</strong> ${toEmail}<br/>
                      <strong style="color:#ffffff;">Password:</strong> The password you set during registration
                    </p>
                  </td>
                </tr>
              </table>
              <!-- Next Steps -->
              <p style="margin:0 0 12px;font-size:0.85rem;font-weight:700;color:#ffffff;">What's Next?</p>
              <ul style="margin:0 0 24px;padding-left:20px;font-size:0.85rem;color:#888888;line-height:1.8;">
                <li>Complete your bar profile and upload photos</li>
                <li>Set up your menu and pricing</li>
                <li>Create events and promotions</li>
                <li>Start accepting reservations</li>
              </ul>
              <!-- Support Note -->
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="background:#161616;border:1px solid rgba(255,255,255,0.06);border-left:3px solid #CC0000;border-radius:8px;padding:12px 16px;">
                    <p style="margin:0;font-size:0.78rem;color:#888888;line-height:1.6;">
                      💬 Need help? Contact our support team or check the platform documentation for guidance.
                    </p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <!-- Footer -->
          <tr>
            <td style="padding:20px 40px;border-top:1px solid rgba(255,255,255,0.06);">
              <p style="margin:0;font-size:0.72rem;color:#444444;text-align:center;">
                © ${new Date().getFullYear()} The Party Goers PH · Cavite, Philippines<br/>
                Welcome to our platform! We're excited to have you onboard.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
    `.trim(),
  });
}

async function sendPasswordResetEmail(toEmail, firstName, token) {
  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
  const resetLink = `${frontendUrl}/reset-password?token=${token}`;

  await transporter.sendMail({
    from: `"The Party Goers PH" <${process.env.SMTP_USER}>`,
    to: toEmail,
    subject: 'Reset your Party Goers password',
    html: `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Reset your password</title>
</head>
<body style="margin:0;padding:0;background:#0A0A0A;font-family:'DM Sans',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0A0A0A;padding:40px 0;">
    <tr>
      <td align="center">
        <table width="560" cellpadding="0" cellspacing="0" style="background:#111111;border-radius:16px;border:1px solid rgba(255,255,255,0.06);overflow:hidden;max-width:560px;width:100%;">
          <!-- Header -->
          <tr>
            <td style="background:linear-gradient(135deg,#1a0000 0%,#111111 100%);padding:36px 40px 28px;border-bottom:1px solid rgba(204,0,0,0.2);">
              <span style="font-size:1.4rem;font-weight:800;color:#ffffff;letter-spacing:-0.5px;">Party<span style="color:#CC0000;">Goers</span> PH</span>
            </td>
          </tr>
          <!-- Body -->
          <tr>
            <td style="padding:36px 40px;">
              <p style="margin:0 0 8px;font-size:0.78rem;font-weight:700;text-transform:uppercase;letter-spacing:2px;color:#CC0000;">Password Reset</p>
              <h1 style="margin:0 0 16px;font-size:1.6rem;font-weight:800;color:#ffffff;line-height:1.2;">Hey ${firstName}, reset your password</h1>
              <p style="margin:0 0 28px;font-size:0.95rem;color:#888888;line-height:1.7;">
                We received a request to reset your password. Click the button below to choose a new one. If you didn't request this, you can safely ignore this email.
              </p>
              <!-- CTA Button -->
              <table cellpadding="0" cellspacing="0" width="100%">
                <tr>
                  <td align="center" style="padding-bottom:28px;">
                    <a href="${resetLink}" target="_blank"
                       style="display:inline-block;padding:14px 36px;background:#CC0000;color:#ffffff;text-decoration:none;border-radius:100px;font-size:0.95rem;font-weight:700;letter-spacing:0.5px;">
                      Reset My Password
                    </a>
                  </td>
                </tr>
              </table>
              <!-- Fallback link -->
              <p style="margin:0 0 24px;font-size:0.78rem;color:#555555;line-height:1.6;">
                If the button doesn't work, copy and paste this link into your browser:<br/>
                <a href="${resetLink}" style="color:#CC0000;word-break:break-all;">${resetLink}</a>
              </p>
              <!-- Note -->
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="background:#161616;border:1px solid rgba(255,255,255,0.06);border-left:3px solid #CC0000;border-radius:8px;padding:12px 16px;">
                    <p style="margin:0;font-size:0.78rem;color:#888888;line-height:1.6;">
                      This link expires in <strong style="color:#ffffff;">1 hour</strong>. If you did not request a password reset, no action is needed.
                    </p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <!-- Footer -->
          <tr>
            <td style="padding:20px 40px;border-top:1px solid rgba(255,255,255,0.06);">
              <p style="margin:0;font-size:0.72rem;color:#444444;text-align:center;">
                © ${new Date().getFullYear()} The Party Goers PH · Cavite, Philippines<br/>
                You're receiving this because a password reset was requested for your account.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
    `.trim(),
  });
}

module.exports = { sendVerificationEmail, sendBarApprovalEmail, sendPasswordResetEmail };
