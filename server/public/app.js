'use strict';
const $ = id => document.getElementById(id);
const forms = ['login-form','otp-form','setup-form','setup-confirm-form'];
let challenge = '', setupChallenge = '', people = [], selectedId = null, searchPhone = '';
let map = null, markers = new Map(), poll = null, refreshing = false, firstBounds = true, dashboardEpoch = 0;
const apiBase = window.TRACKER_CONFIG?.apiBase || '';
let adminToken = ''; // In memory only; reloading a Pages tab requires signing in.
const faNumber = new Intl.NumberFormat('fa-IR');
const digits = v => String(v).replace(/[۰-۹]/g,c=>String('۰۱۲۳۴۵۶۷۸۹'.indexOf(c))).replace(/[٠-٩]/g,c=>String('٠١٢٣٤٥٦٧٨٩'.indexOf(c)));
async function api(path, data) {
  if (window.TRACKER_CONFIG?.unconfigured) throw new Error('راه‌اندازی سامانه هنوز کامل نشده است.');
  const headers = data ? { 'Content-Type':'application/json' } : {};
  if (apiBase && adminToken) headers.Authorization = 'Bearer ' + adminToken;
  const response = await fetch(apiBase + path, { method: data ? 'POST' : 'GET', credentials: apiBase ? 'omit' : 'same-origin',
    cache: 'no-store', redirect: 'error', headers, body: data ? JSON.stringify(data) : undefined });
  const payload = await response.json();
  if (!response.ok) { const error = new Error(payload.error || 'ارتباط با سامانه برقرار نشد.'); error.status = response.status; throw error; }
  return payload;
}
function showForm(id) { forms.forEach(f => $(f).hidden = f !== id); $('auth-loading').hidden = true; }
function message(text, success=false) { $('auth-message').textContent = text; $('auth-message').classList.toggle('success',success); }
async function formAction(form, action) {
  const buttons = [...form.querySelectorAll('button')]; buttons.forEach(b=>b.disabled=true); message('');
  try { await action(); } catch(e) { message(e.message); } finally { buttons.forEach(b=>b.disabled=false); }
}
$('login-form').addEventListener('submit',e=>{ e.preventDefault(); formAction(e.currentTarget, async()=>{
  const result = await api('/api/admin/login',{username:$('username').value.trim(),password:$('password').value});
  $('password').value=''; challenge=result.challenge; showForm('otp-form'); $('otp').value=''; $('otp').focus();
}); });
$('otp-form').addEventListener('submit',e=>{ e.preventDefault(); formAction(e.currentTarget, async()=>{
  const result=await api('/api/admin/verify',{challenge,code:digits($('otp').value)});
  adminToken=result.token || '';challenge=''; $('otp').value=''; await openDashboard();
}); });
$('back-login').onclick=()=>{challenge='';$('otp').value='';showForm('login-form');message('');};
$('setup-form').addEventListener('submit',e=>{e.preventDefault();formAction(e.currentTarget,async()=>{
  const result=await api('/api/admin/setup',{setupToken:$('setup-token').value,username:$('new-username').value.trim(),password:$('new-password').value});
  $('setup-token').value='';$('new-password').value='';setupChallenge=result.challenge;$('totp-secret').value=result.secret;showForm('setup-confirm-form');
});});
$('copy-secret').onclick=async()=>{try{await navigator.clipboard.writeText($('totp-secret').value);message('کلید کپی شد.',true);}catch{$('totp-secret').select();message('کلید را انتخاب و کپی کنید.',true);}};
$('setup-confirm-form').addEventListener('submit',e=>{e.preventDefault();formAction(e.currentTarget,async()=>{
  await api('/api/admin/setup/confirm',{challenge:setupChallenge,code:digits($('setup-otp').value)});
  setupChallenge='';$('totp-secret').value='';$('setup-otp').value='';showForm('login-form');
  message('حساب آماده است. برای ورود، کد بعدی Ente Auth را استفاده کنید.',true);
});});
function fresh(person){return person.consent && person.capturedAt && Date.now()-person.capturedAt<120000;}
function age(time){if(!time)return 'موقعیتی دریافت نشده';const seconds=Math.max(0,Math.floor((Date.now()-time)/1000));if(seconds<60)return `${faNumber.format(seconds)} ثانیه پیش`;if(seconds<3600)return `${faNumber.format(Math.floor(seconds/60))} دقیقه پیش`;if(seconds<86400)return `${faNumber.format(Math.floor(seconds/3600))} ساعت پیش`;return `${faNumber.format(Math.floor(seconds/86400))} روز پیش`;}
function validLocation(person){return person.consent && Number.isFinite(person.latitude)&&Number.isFinite(person.longitude);}
function personStatus(p){return !p.consent?'ارسال توسط کاربر متوقف شده':!p.capturedAt?'در انتظار موقعیت':`${fresh(p)?'موقعیت تازه':'موقعیت قدیمی'} · ${age(p.capturedAt)}`;}
function textElement(tag,text,className){const el=document.createElement(tag);el.textContent=text;if(className)el.className=className;return el;}
function renderList(){
  $('people-count').textContent=`افراد (${faNumber.format(people.length)})`;
  $('list-message').textContent=searchPhone?'نتیجهٔ جست‌وجوی شماره موبایل':'آخرین موقعیت هر فرد نمایش داده می‌شود.';
  $('people-list').replaceChildren();
  if(!people.length){$('people-list').append(textElement('p',searchPhone?'فردی با این شماره یافت نشد.':'هنوز فردی ثبت‌نام نکرده است.','empty-state'));return;}
  people.forEach(p=>{
    const row=document.createElement('button');row.type='button';row.className='person'+(p.id===selectedId?' selected':'');
    row.append(textElement('span',p.name.slice(0,1),'person-avatar'));
    const content=document.createElement('span');content.className='person-text';content.append(textElement('span',p.name,'person-name'),textElement('span',p.phone,'person-phone'),textElement('span',personStatus(p),'person-status'));row.append(content);row.onclick=()=>selectPerson(p.id);$('people-list').append(row);
  });
}
function selectPerson(id){selectedId=id;renderList();renderDetail();const p=people.find(p=>p.id===id);if(map&&validLocation(p))map.flyTo({center:[p.longitude,p.latitude],zoom:15,essential:false});}
function renderDetail(){const p=people.find(p=>p.id===selectedId);const box=$('person-detail');box.replaceChildren();if(!p){box.hidden=true;return;}box.hidden=false;
  const close=textElement('button','×','quiet');close.setAttribute('aria-label','بستن اطلاعات فرد');close.onclick=()=>{selectedId=null;renderList();renderDetail();};box.append(close,textElement('h2',p.name));
  const mobile=textElement('p',p.phone);mobile.dir='ltr';mobile.style.textAlign='right';box.append(mobile,textElement('p',personStatus(p)));
  if(validLocation(p)){box.append(textElement('p',`دقت: ${faNumber.format(Math.round(p.accuracy))} متر`));const coords=textElement('p',`${p.latitude.toFixed(6)}, ${p.longitude.toFixed(6)}`);coords.dir='ltr';coords.style.textAlign='right';box.append(coords);if(p.battery!==null)box.append(textElement('p',`باتری: ${faNumber.format(p.battery)}٪`));box.append(textElement('p',`زمان ثبت: ${new Date(p.capturedAt).toLocaleString('fa-IR')}`));}
}
function renderMarkers(){if(!map)return;const current=new Set(people.filter(validLocation).map(p=>p.id));for(const [id,m]of markers){if(!current.has(id)){m.remove();markers.delete(id);}}
  for(const p of people.filter(validLocation)){
    let marker=markers.get(p.id);if(!marker){const el=textElement('button',p.name.slice(0,1),'pin');el.type='button';el.setAttribute('aria-label',`مشاهدهٔ ${p.name}`);el.onclick=()=>selectPerson(p.id);marker=new maplibregl.Marker({element:el}).setLngLat([p.longitude,p.latitude]).addTo(map);markers.set(p.id,marker);}marker.setLngLat([p.longitude,p.latitude]);marker.getElement().classList.toggle('stale',!fresh(p));
  }
  if(firstBounds&&current.size){fitPeople();firstBounds=false;}
}
function fitPeople(){if(!map)return;const located=people.filter(validLocation);if(!located.length)return;const bounds=new maplibregl.LngLatBounds();located.forEach(p=>bounds.extend([p.longitude,p.latitude]));map.fitBounds(bounds,{padding:60,maxZoom:15,duration:700});}
function initMap(){
  if(map)return;try{
    if(!window.maplibregl)throw new Error('ابزار نمایش نقشه بارگذاری نشده است. صفحه را دوباره بارگذاری کنید.');
    maplibregl.setRTLTextPlugin(new URL('./vendor/rtl-text-plugin.js',document.baseURI).href,true);
    map=new maplibregl.Map({container:'map',style:'https://tiles.openfreemap.org/styles/liberty',center:[53.688,32.4279],zoom:4.5,attributionControl:true});
    map.addControl(new maplibregl.NavigationControl(),'top-left');
    map.on('load',()=>{$('map-message').hidden=true;renderMarkers();});
    map.on('error',()=>{$('map-message').textContent='دریافت بخشی از نقشه انجام نشد؛ اتصال اینترنت را بررسی کنید.';$('map-message').hidden=false;});
  }catch(e){$('map-message').textContent='نمایش نقشه انجام نشد؛ اتصال اینترنت و به‌روز بودن مرورگر را بررسی کنید.';$('map-message').hidden=false;console.error('Map initialization failed:',e.message);}
}
async function refresh(){if(refreshing)return;const epoch=dashboardEpoch;refreshing=true;$('refresh').disabled=true;try{
  const result=await api('/api/admin/people'+(searchPhone?'?phone='+encodeURIComponent(searchPhone):''));if(epoch!==dashboardEpoch)return;people=result.people;
  if(selectedId&&!people.some(p=>p.id===selectedId))selectedId=null;renderList();renderDetail();renderMarkers();
  $('connection').textContent='به‌روز شد: '+new Date().toLocaleTimeString('fa-IR');
}catch(e){if(epoch!==dashboardEpoch)return;if(e.status===401){closeDashboard();showForm('login-form');message('نشست شما پایان یافته است. دوباره وارد شوید.');}else $('connection').textContent='ارتباط قطع است؛ تلاش دوباره انجام می‌شود.';}finally{refreshing=false;$('refresh').disabled=false;}}
async function openDashboard(){dashboardEpoch++;$('auth').hidden=true;$('dashboard').hidden=false;initMap();if(map)map.resize();await refresh();if(!poll&&!$('dashboard').hidden)poll=setInterval(refresh,5000);}
function closeDashboard(){dashboardEpoch++;if(poll)clearInterval(poll);poll=null;adminToken='';$('dashboard').hidden=true;$('auth').hidden=false;people=[];selectedId=null;firstBounds=true;searchPhone='';$('search-phone').value='';markers.forEach(m=>m.remove());markers.clear();renderList();renderDetail();}
$('refresh').onclick=refresh;
$('logout').onclick=async()=>{try{await api('/api/admin/logout',{});closeDashboard();showForm('login-form');message('از سامانه خارج شدید.',true);}catch(e){if(apiBase){closeDashboard();showForm('login-form');message('از این صفحه خارج شدید.',true);}else $('connection').textContent=e.message;}};
$('search-form').addEventListener('submit',async e=>{e.preventDefault();searchPhone=digits($('search-phone').value.trim());selectedId=null;firstBounds=true;await refresh();});
$('show-all').onclick=async()=>{searchPhone='';$('search-phone').value='';selectedId=null;firstBounds=true;await refresh();fitPeople();};
document.addEventListener('visibilitychange',()=>{if(!document.hidden&&!$('dashboard').hidden)refresh();});
(async()=>{try{const status=await api('/api/admin/status');if(!status.configured){showForm('setup-form');return;}try{const result=await api('/api/admin/people');people=result.people;await openDashboard();}catch(e){if(e.status!==401)throw e;showForm('login-form');}}catch(e){$('auth-loading').textContent='اتصال به سامانه برقرار نشد. صفحه را دوباره بارگذاری کنید.';message(e.message);}})();
