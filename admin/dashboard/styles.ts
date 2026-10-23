// Dashboard styles embedded into the served HTML at build time.

export const dashboardStyles = `:root{--bg:#0f172a;--panel:#1e293b;--panel-2:#273449;--text:#e2e8f0;--muted:#94a3b8;--accent:#3b82f6;--ok:#22c55e;--warn:#f59e0b;--err:#ef4444;--border:#334155;}
*{box-sizing:border-box;}
body{margin:0;background:var(--bg);color:var(--text);font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;font-size:15px;line-height:1.5;}
a{color:var(--accent);}
button{font:inherit;cursor:pointer;border-radius:8px;border:1px solid var(--border);background:var(--panel-2);color:var(--text);padding:7px 12px;transition:filter .15s;}
button:hover{filter:brightness(1.15);}
button:disabled{opacity:.5;cursor:not-allowed;}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff;}
button.ok{background:#166534;border-color:#166534;color:#dcfce7;}
button.danger{background:#7f1d1d;border-color:#7f1d1d;color:#fee2e2;}
input,select,textarea{font:inherit;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:8px;padding:7px 10px;width:100%;}
label{display:block;color:var(--muted);font-size:13px;margin-bottom:4px;}
.layout{display:flex;min-height:100vh;}
.sidebar{width:220px;flex:0 0 220px;background:var(--panel);border-right:1px solid var(--border);padding:18px 14px;display:flex;flex-direction:column;gap:10px;position:sticky;top:0;height:100vh;overflow-y:auto;}
.brand{font-weight:700;font-size:17px;letter-spacing:.2px;padding:0 8px;}
.brand span{color:var(--accent);}
.sidebar .nav{display:flex;flex-direction:column;gap:4px;flex:1;}
.sidebar .nav a{display:flex;align-items:center;gap:9px;text-align:left;text-decoration:none;color:var(--text);background:transparent;border:1px solid transparent;border-radius:8px;padding:9px 12px;}
.sidebar .nav a .nav-icon{width:16px;height:16px;flex:0 0 16px;color:var(--muted);}
.sidebar .nav a:hover .nav-icon{color:var(--text);}
.sidebar .nav a.active .nav-icon{color:#fff;}
.sidebar .nav a:hover{background:var(--panel-2);}
.sidebar .nav a.active{background:var(--accent);border-color:var(--accent);color:#fff;}
.sidebar .nav .subnav{display:flex;flex-direction:column;gap:2px;margin:2px 0 4px 12px;padding-left:8px;border-left:1px solid var(--border);}
.sidebar .nav .subnav a.sub{padding:5px 10px;font-size:13px;color:var(--muted);}
.sidebar .nav .subnav a.sub:hover{color:var(--text);background:var(--panel-2);}
.sidebar .nav .subnav a.sub.active{background:var(--panel-2);border-color:var(--border);color:#fff;}
.sidebar .footer{display:flex;flex-direction:column;gap:8px;border-top:1px solid var(--border);padding-top:12px;}
.sidebar .who{color:var(--muted);font-size:13px;padding:0 8px;word-break:break-word;}
.content{flex:1;min-width:0;}
main{max-width:1080px;margin:0 auto;padding:22px;}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;}
.card{background:var(--panel);border:1px solid var(--border);border-radius:12px;padding:16px;}
.stat .value{font-size:26px;font-weight:700;}
.stat .label{color:var(--muted);font-size:13px;}
.card h2{margin:0 0 12px;font-size:16px;}
.toolbar{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:14px;}
.toolbar .grow{flex:1;min-width:180px;}
table{width:100%;border-collapse:collapse;}
th,td{text-align:left;padding:10px 8px;border-bottom:1px solid var(--border);vertical-align:top;}
th{color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.4px;}
tr:hover td{background:rgba(255,255,255,.02);}
.badge{display:inline-block;padding:2px 9px;border-radius:999px;font-size:12px;border:1px solid var(--border);}
.badge.pending{background:#78350f;border-color:#78350f;color:#fde68a;}
.badge.open{background:#14532d;border-color:#14532d;color:#bbf7d0;}
.badge.closed{background:#3f3f46;border-color:#3f3f46;color:#e4e4e7;}
.badge.archived{background:#1e3a8a;border-color:#1e3a8a;color:#bfdbfe;}
.muted{color:var(--muted);}
.small{font-size:13px;}
.actions{display:flex;gap:6px;flex-wrap:wrap;}
.login{max-width:360px;margin:12vh auto;padding:26px;background:var(--panel);border:1px solid var(--border);border-radius:14px;}
.login h1{margin:0 0 6px;font-size:20px;}
.login p{color:var(--muted);margin:0 0 18px;font-size:14px;}
.login button{width:100%;margin-top:12px;}
.error{color:var(--err);font-size:13px;min-height:18px;margin-top:8px;}
.toast{position:fixed;right:20px;bottom:20px;background:var(--panel-2);border:1px solid var(--border);border-left:4px solid var(--accent);padding:12px 16px;border-radius:10px;max-width:340px;box-shadow:0 10px 30px rgba(0,0,0,.4);}
.toast.err{border-left-color:var(--err);}
.setting-row{display:grid;grid-template-columns:220px 1fr auto;gap:12px;align-items:end;padding:12px 0;border-bottom:1px solid var(--border);}
.setting-row .meta{color:var(--muted);font-size:12px;grid-column:1/2;}
.pager{display:flex;gap:10px;align-items:center;justify-content:flex-end;margin-top:14px;}
.pager span{color:var(--muted);font-size:13px;}
.empty{color:var(--muted);padding:20px 0;text-align:center;}
.desc{max-width:520px;color:var(--muted);font-size:13px;}
.turnstile{margin-top:12px;min-height:65px;}
.pre{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;white-space:pre-wrap;word-break:break-word;color:var(--muted);}
.badge.active{background:#14532d;border-color:#14532d;color:#bbf7d0;}
.badge.disabled{background:#7f1d1d;border-color:#7f1d1d;color:#fee2e2;}
.badge.priority{background:#7f1d1d;border-color:#7f1d1d;color:#fee2e2;}
.accent{color:var(--accent);}
.text-err{color:var(--err);}
.mt-12{margin-top:12px;}
.mt-18{margin-top:18px;}
.w-80{width:80px;}
.min-w-150{min-width:150px;}
.min-w-160{min-width:160px;}
.title-editor{margin-top:8px;}
.row-priority{box-shadow:inset 3px 0 0 var(--err);}
.card-link{text-decoration:none;color:inherit;}
.card-link.alert{border-color:var(--err);}
.image-preview{max-height:60px;margin-top:4px;}
.image-url{margin:6px 0 10px;word-break:break-all;}
.file-upload input[type="url"]{margin-top:2px;}
@media(max-width:720px){.setting-row{grid-template-columns:1fr;}.layout{flex-direction:column;}.sidebar{width:auto;height:auto;position:static;flex-direction:row;flex-wrap:wrap;align-items:center;gap:8px;}.sidebar .brand{width:100%;margin-bottom:6px;}.sidebar .nav{flex-direction:row;flex-wrap:wrap;flex:0 0 auto;width:100%;}.sidebar .nav .subnav{flex-direction:row;flex-wrap:wrap;margin:0;padding-left:0;border-left:none;width:100%;}.sidebar .footer{border-top:none;padding-top:0;flex-direction:row;flex-wrap:wrap;width:100%;}.sidebar .who{width:100%;}}`;
