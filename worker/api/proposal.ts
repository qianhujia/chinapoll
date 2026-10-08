export async function handleProposalRequest(request: Request, env: any): Promise<Response> {
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ ok: false, message: 'POST only' }), {
      status: 405,
      headers: { 'content-type': 'application/json' }
    });
  }

  let body: any;

  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ ok: false, message: 'invalid JSON' }), {
      status: 400,
      headers: { 'content-type': 'application/json' }
    });
  }

  const text = String(body.text ?? '').trim();
  const tokenHash = String(body.tokenHash ?? '').trim();
  const email = String(body.email ?? '').trim();

  if (!text || !tokenHash) {
    return new Response(JSON.stringify({ ok: false, message: 'missing required fields' }), {
      status: 400,
      headers: { 'content-type': 'application/json' }
    });
  }

  const pollerId = email ? `@poller_${Math.random().toString(16).slice(2, 10)}` : '(anonymous)';

  // Production implementation: create identities table and store email_hmac = HMAC-SHA256(email, SERVER_SECRET)
  // Keep the public proposal CSV free of email values; expose only poller_id / anonymous alias.

  return new Response(JSON.stringify({
    ok: true,
    message: 'proposal submitted for review',
    proposalId: `PROP-${Date.now().toString().slice(-4)}`,
    submitter: pollerId
  }), {
    headers: { 'content-type': 'application/json' }
  });
}
