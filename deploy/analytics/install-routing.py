#!/usr/bin/env python3
"""Install only Safety Radar measurement routes/log sanitization; never read app credentials."""
from pathlib import Path
import re,os,stat,shutil,subprocess
ROOT=Path('/srv/safetyradar/app')
CONFIG=Path('/etc/caddy/Caddyfile')
old=CONFIG.read_text();updated=old

def replace_site(text,host,fn):
 m=re.search(r'^'+re.escape(host)+r'\s*\{',text,re.M)
 if not m:raise RuntimeError('missing expected public site '+host)
 end=m.end();depth=1
 while depth and end<len(text):
  depth+=(text[end]=='{')-(text[end]=='}');end+=1
 if depth:raise RuntimeError('unbalanced Caddy site')
 return text[:m.start()]+fn(text[m.start():end])+text[end:]

def main_site(block):
 if '# BEGIN SR aggregate routes' in block:return block
 start=block.rfind('\n',0,block.index('# IP-free page log'))+1;end=block.index('\n\tencode ',start)+1
 block=block[:start]+(ROOT/'deploy/caddy/access-log.snippet').read_text()+block[end:]
 marker='\n\tfile_server\n}'
 if marker not in block:raise RuntimeError('expected static server boundary missing')
 return block.replace(marker,'''\n\t# BEGIN SR aggregate routes
\thandle /_measure* {\n\t\theader Cache-Control no-store\n\t\treverse_proxy 127.0.0.1:9112\n\t}
\thandle {\n\t\tfile_server\n\t}
\t# END SR aggregate routes
}''')

def news_site(block):
 if '# BEGIN SR newsletter aggregate routes' in block:return block
 old_proxy='\treverse_proxy 127.0.0.1:9100'
 if old_proxy not in block:raise RuntimeError('expected newsletter proxy missing')
 return block.replace(old_proxy,'''\t# BEGIN SR newsletter aggregate routes
\theader Referrer-Policy no-referrer
\thandle /_measure* {\n\t\treverse_proxy 127.0.0.1:9112\n\t}
\t@sr_assets path /measurement-core.mjs /measurement-listmonk.mjs /newsletter-lists.mjs
\thandle @sr_assets {\n\t\troot * /srv/safetyradar/www\n\t\tfile_server\n\t}
\thandle {\n\t\treverse_proxy 127.0.0.1:9100\n\t}
\t# END SR newsletter aggregate routes''')
updated=replace_site(updated,'safetyradar.ch',main_site);updated=replace_site(updated,'news.safetyradar.ch',news_site)
st=CONFIG.stat();tmp=CONFIG.with_name('.safetyradar-analytics-check.Caddyfile');tmp.write_text(updated);os.chmod(tmp,stat.S_IMODE(st.st_mode));os.chown(tmp,st.st_uid,st.st_gid)
try:
 check=subprocess.run(['caddy','validate','--adapter','caddyfile','--config',str(tmp)],capture_output=True,text=True)
 if check.returncode:raise RuntimeError('Caddy validation failed: '+check.stderr)
 if updated!=old:
  backup=CONFIG.with_name('Caddyfile.before-sr-aggregate');backup.write_text(old);os.chmod(backup,0o600)
  os.replace(tmp,CONFIG)
  try:subprocess.run(['systemctl','reload','caddy'],check=True)
  except Exception:
   CONFIG.write_text(old);os.chmod(CONFIG,stat.S_IMODE(st.st_mode));os.chown(CONFIG,st.st_uid,st.st_gid);raise
 print('Safety Radar routing and IP-free log validation OK')
finally:
 if tmp.exists():tmp.unlink()
