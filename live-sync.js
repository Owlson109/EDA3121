/* Only the top-level audience deck has a cloud connection. The presenter
   popup sends navigation requests to its opener through the existing runtime. */
async function initLiveSync() {
  if (window !== window.top || new URLSearchParams(location.search).has('preview')) return;
  const nav = window.edaDeck;
  if (!nav) return;
  const presenter = new URLSearchParams(location.search).get('present') === '1';
  const status = document.querySelector('#eda-state'), button = document.querySelector('#eda-start');
  const dialog = document.querySelector('#eda-login'), form = dialog.querySelector('form');
  const message = dialog.querySelector('[role=status]');
  const copy = {
    free:['自由瀏覽','Free browsing'], follow:['跟隨講者','Following presenter'], live:['同步中','Live'],
    connecting:['正在連線','Connecting'], reconnect:['重新連線中','Reconnecting'], pending:['正在確認寫入','Confirming update'],
    start:['開始同步','Start sync'], stop:['結束同步','End sync'], stopping:['正在結束同步','Ending sync'],
    login:['主持人登入','Presenter sign-in'], email:['電郵','Email'], password:['密碼','Password'],
    cancel:['取消','Cancel'], settings:['自由瀏覽 · Firebase 尚未設定','Free browsing · Firebase not configured'],
    offline:['自由瀏覽 · 無法連線','Free browsing · Connection unavailable'],
    auth:['登入失敗，請檢查電郵和密碼。','Sign-in failed. Check your email and password.'],
    denied:['寫入失敗，請檢查講者 UID 及規則。','Write denied. Check the speaker UID and database rules.'],
    busy:['已有講者同步中。','Another presenter is already live.'], network:['未連上資料庫，請稍後再試。','Database unavailable. Try again when connected.'],
    endingError:['清除頁碼失敗，請重試結束同步。','Could not clear the page. Try ending sync again.']
  };
  const tr = key => copy[key][window.edaLanguage?.current === 'en' ? 1 : 0];
  const config = window.edaFirebaseConfig;
  let role = 'reader', connected = false, remote = null, warning = '', formError = '', loaded = false, seen = false;
  let observations = 0, everConnected = false, loading = false;
  let auth, db, page, sdk, claim, acknowledged = null, writing = false, resume = false, busy = false;
  function render() {
    const controlling = role === 'host' || role === 'ending';
    const state = warning || (role === 'ending' ? 'stopping' : config?.databaseURL && !connected ? (everConnected ? 'reconnect' : 'connecting') :
      role === 'starting' || controlling && (writing || resume) ? 'pending' : controlling ? 'live' :
      remote !== null ? 'follow' : 'free');
    document.body.classList.toggle('audience-following', !presenter && connected && remote !== null);
    status.textContent = tr(state);
    button.hidden = !presenter;
    button.textContent = tr(controlling ? 'stop' : 'start');
    button.disabled = busy || role === 'ending';
    for (const el of dialog.querySelectorAll('[data-copy]')) el.textContent = tr(el.dataset.copy);
    message.textContent = formError ? tr(formError) : '';
    form.querySelector('[type=submit]').disabled = busy || !loaded;
    if (!config && !presenter) status.textContent = tr('free');
  }
  window.addEventListener('eda-language-change',render);
  nav.allow = () => role !== 'reader' || !connected || remote === null;
  nav.acceptBroadcast = () => role === 'reader' && remote === null;
  function follow(value) {
    remote = nav.valid(value) ? value : null;
    if (remote !== null) nav.follow(remote);
  }
  button.onclick = () => {
    if (role === 'host') { end(); return; }
    formError = !config ? 'settings' : !connected ? 'network' : '';
    render(); dialog.showModal();
  };
  dialog.querySelector('[data-copy=cancel]').onclick = () => dialog.close();
  dialog.addEventListener('close', () => { form.password.value = ''; });
  dialog.addEventListener('keydown', e => e.stopPropagation());
  // Escape a form or submit with Enter without passing keys to the deck.
  form.onsubmit = async event => {
    event.preventDefault();
    if (busy || !connected || !seen || !auth) { formError='network'; render(); return; }
    busy = true; formError=''; warning=''; role='starting'; render();
    let acquired = false, signedIn = false;
    try {
      await sdk.signInWithEmailAndPassword(auth,form.email.value.trim(),form.password.value);
      signedIn = true; form.password.value = '';
      if (!dialog.open) throw Error('cancelled');
      const startPage = nav.current();
      const result = await sdk.runTransaction(page, old => old === null ? startPage : undefined, {applyLocally:false});
      if (!result.committed) { formError='busy'; throw Error('occupied'); }
      acquired = true; acknowledged=startPage;
      await claim.remove();
      if (!dialog.open) throw Error('cancelled');
      role='host'; remote=null; dialog.close();
    } catch (e) {
      form.password.value='';
      if (!formError) formError = !connected ? 'network' : signedIn ? 'denied' : 'auth';
      if (acquired) {
        // Keep an authenticated owner available to retry cleanup if removal fails.
        try { await claim.cancel(); await sdk.remove(page); acquired=false; } catch { warning='endingError'; }
      }
      role=acquired?'host':'reader';
      if (!acquired && auth) await sdk.signOut(auth);
      if (!acquired) follow(remote);
      if (!dialog.open && !acquired) { formError=''; warning=''; }
    } finally { busy=false; render(); }
    if (role === 'host' && !warning) publish();
  };
  async function publish() {
    if (role !== 'host' || writing || !connected || resume) return;
    writing=true; warning=''; render();
    try {
      // Coalesce clicks while a write is awaiting its server acknowledgement.
      while (role === 'host' && connected && !resume && acknowledged !== nav.current()) {
        const target=nav.current();
        await sdk.set(page,target); acknowledged=target;
      }
    } catch { warning='denied'; }
    finally { writing=false; render(); }
  }
  window.addEventListener('eda-page-change',publish);
  async function end() {
    role='ending'; warning=''; render();
    try {
      // The SDK sends writes from this connection in order. Remove the
      // disconnect hook before deletion so it cannot later erase a new session.
      await claim.cancel(); await sdk.remove(page);
      await sdk.signOut(auth);
      role='reader'; acknowledged=null; remote=null; resume=false;
    } catch { role='host'; warning='endingError'; }
    render();
  }
  async function connection(up) {
    connected=up;
    if (up) everConnected=true;
    render();
    // A reader may have browsed offline. A fresh read also catches an
    // unchanged server value, for which onValue need not fire again.
    if (up && role === 'reader' && seen) {
      const version=observations;
      try {
        const snapshot=await sdk.get(page);
        if (role==='reader' && connected && observations===version) follow(snapshot.val());
      } catch { if (connected && observations===version) { warning='offline'; remote=null; } }
    }
    if (!up && role === 'host') resume=true;
    if (up && resume && role === 'host') {
      busy=true;
      try {
        const target=nav.current();
        const result=await sdk.runTransaction(page,old=>old===null?target:undefined,{applyLocally:false});
        if (!result.committed) {
          role='reader'; await sdk.signOut(auth); follow(result.snapshot.val()); warning='busy';
        } else { await claim.remove(); acknowledged=target; warning=''; }
      } catch { warning='denied'; }
      finally { busy=false; resume=false; render(); }
      if (!warning) publish();
    }
    render();
  }
  render();
  if (!config?.databaseURL || !config.apiKey) { warning=presenter?'settings':''; render(); return; }
  async function connect() {
    if (loaded || loading) return;
    loading=true; warning=''; render();
    try {
      const base='https://www.gstatic.com/firebasejs/11.10.0/';
      const [app,database,authentication]=await Promise.all([
        import(base+'firebase-app.js'),import(base+'firebase-database.js'),
        presenter ? import(base+'firebase-auth.js') : Promise.resolve({})
      ]);
      sdk={...database,...authentication};
      const instance=app.getApps().find(a=>a.name==='EDA3121') || app.initializeApp(config,'EDA3121');
      db=sdk.getDatabase(instance);
      // The local preview server alone supplies this flag, on loopback.
      const local=location.hostname==='127.0.0.1' && window.edaLocalEmulators===true;
      if (local) sdk.connectDatabaseEmulator(db,'127.0.0.1',19000);
      page=sdk.ref(db,'presentations/EDA3121/page');
      if (presenter) {
        auth=sdk.initializeAuth(instance,{persistence:sdk.inMemoryPersistence});
        if (local) sdk.connectAuthEmulator(auth,'http://127.0.0.1:19099',{disableWarnings:true});
        claim=sdk.onDisconnect(page);
      }
      loaded=true;
      sdk.onValue(sdk.ref(db,'.info/connected'),s=>connection(s.val()===true));
      sdk.onValue(page,s=>{
        observations++; seen=true;
        if (role==='reader') { warning=''; follow(s.val()); }
        else if (role==='starting') remote=s.val();
        render();
      },()=>{seen=false;remote=null;warning='offline';render();});
      render();
    } catch {warning='offline';render();}
    finally { loading=false; }
  }
  window.addEventListener('online',connect);
  await connect();
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded',initLiveSync);
else initLiveSync();
