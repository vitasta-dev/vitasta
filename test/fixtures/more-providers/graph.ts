const r = await fetch(`https://graph.facebook.com/v24.0/act_${id}/insights?fields=spend`);
const me = await fetch("https://graph.facebook.com/v24.0/me?fields=id,name");
const c = await fetch("https://graph.facebook.com/v24.0/act_123/campaigns");
