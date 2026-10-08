// Password wall for Boiler Eggs (Vercel Routing Middleware). One shared password: LAB_PASSWORD on the project, or the
// built-in one (its hash below) when the variable is not set. A cookie carrying a hash opens the gate for 30 days.
export const config = { matcher: '/:path*', runtime: 'edge' };

const LAB_DEFAULT_HASH = '1e342f15fc9ce117178041965605746a36328f225eb71a2ddc1ded0671ec0d5f';   // sha256('lab-gate:' + the built-in password)
const COOKIE = 'lab_pass';
const MAX_AGE = 60 * 60 * 24 * 30;

async function sha256(text) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function page(wrong) {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Lab</title>
<style>
html,body{height:100%;margin:0;background:#0b0b0d;color:#e4e6f0;font:13px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace}
form{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);display:flex;flex-direction:column;gap:10px;width:min(320px,calc(100vw - 32px))}
label{font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#8c8e9a}
input{height:36px;padding:0 10px;background:#000;border:1px solid #2c2e36;border-radius:3px;color:#e4e6f0;font:inherit;outline:none}
input:focus{border-color:#3d7ddc}
button{height:32px;border:1px solid #2c2e36;border-radius:3px;background:linear-gradient(#4a4e5b,#262932);color:#fff;font:inherit;cursor:pointer}
p{margin:0;color:#ef5a5a;font-size:11px;min-height:14px}
</style></head><body>
<form method="post" autocomplete="off"><label for="p">password</label><input id="p" name="password" type="password" autofocus><button type="submit">enter</button><p>${wrong ? 'not it' : ''}</p></form>
</body></html>`;
}

const html = (body, status) => new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });

export default async function middleware(request) {
    const hash = process.env.LAB_PASSWORD ? await sha256('lab-gate:' + process.env.LAB_PASSWORD) : LAB_DEFAULT_HASH;
    const token = await sha256('lab-cookie:' + hash);
    const cookie = request.headers.get('cookie') || '';
    if (cookie.split(/;\s*/).includes(COOKIE + '=' + token)) return;
    if (request.method === 'POST') {
        let given = '';
        try { given = String((await request.formData()).get('password') || ''); } catch (_) { given = ''; }
        if (given && await sha256('lab-gate:' + given) === hash) {
            const url = new URL(request.url);
            return new Response(null, { status: 303, headers: { location: url.pathname + url.search, 'set-cookie': `${COOKIE}=${token}; Path=/; Max-Age=${MAX_AGE}; HttpOnly; Secure; SameSite=Lax` } });
        }
        return html(page(true), 401);
    }
    return html(page(false), 401);
}
