const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function connectionSuccessPage(connectionId) {
  const reference = /^[a-f0-9]{64}$/.test(connectionId ?? '') ? `（connection_id=${connectionId}）` : '';
  const prompt = `我的 MZ MALL eSIM 账号已连接。请调用 get_esim_account${reference}，接着我刚才的需求继续；保留已选套餐，先向我确认商品、数量、金额和付款方式。登录不代表同意付款；如果我之前只要求连接或查询，请不要下单。`;
  const returnUrl = `cursor://anysphere.cursor-deeplink/prompt?text=${encodeURIComponent(prompt)}`;
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>账号连接成功 · MZ MALL eSIM</title>
  <style>
    *{box-sizing:border-box}body{margin:0;background:#f5f7fb;color:#172b45;font:16px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif}
    .brand{padding:28px 32px;color:#2863e5;font-weight:700;font-size:18px;letter-spacing:.02em}.brand span{color:#6b7c93;font-weight:500;margin-left:8px}
    .overlay{position:fixed;inset:0;background:rgba(23,43,69,.26);display:flex;align-items:center;justify-content:center;padding:24px;overflow:auto}
    .dialog{width:100%;max-width:420px;max-height:calc(100vh - 48px);overflow:auto;background:#fff;border:1px solid #e5ebf2;border-radius:20px;padding:36px 32px 28px;text-align:center;box-shadow:0 24px 80px rgba(23,43,69,.18)}
    .check{display:grid;place-items:center;width:60px;height:60px;margin:0 auto 20px;border-radius:50%;background:#e8f7ef;color:#15945f;font-size:34px;line-height:1}
    h1{font-size:24px;line-height:1.4;letter-spacing:-.02em;margin:0 0 10px}p{margin:0;color:#61738c}.return-button{display:block;background:#2863e5;color:#fff;text-decoration:none;border-radius:10px;padding:13px 18px;margin:26px 0 18px;font-weight:600}.return-button:hover{background:#1d50c5}.return-button:focus-visible{outline:3px solid #96b8ff;outline-offset:4px}.fallback{font-size:13px;line-height:1.8}.resume-hint{font-size:12px;line-height:1.8;color:#8290a3;margin-top:8px}
    @media(max-width:480px){.overlay{padding:20px}.dialog{padding:30px 24px 24px}.brand{padding:24px}h1{font-size:22px}}
  </style>
</head>
<body>
  <header class="brand" aria-hidden="true" inert>MZ MALL <span>eSIM</span></header>
  <main class="overlay">
    <section class="dialog" role="dialog" aria-modal="true" aria-labelledby="connection-title" aria-describedby="connection-description">
      <div class="check" aria-hidden="true">✓</div>
      <h1 id="connection-title">账号连接成功</h1>
      <p id="connection-description">返回 Cursor，继续刚才的 eSIM 需求。</p>
      <a class="return-button" href="${escape(returnUrl)}" autofocus>返回 Cursor 继续</a>
      <p class="fallback">未能打开？请手动切回 Cursor。</p>
      <p class="resume-hint">聊天已暂停时，发送“账号已连接，请继续刚才的需求”。</p>
    </section>
  </main>
</body>
</html>`;
}
