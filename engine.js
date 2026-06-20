/* =========================================================================
   engine.js — 決鬥力場 卡牌格鬥遊戲核心邏輯
   -------------------------------------------------------------------------
   這個檔案只放「遊戲規則」：卡牌/角色/場地資料定義、回合結算演算法。
   不含任何畫面或連線程式碼，方便之後新增角色、卡牌、場地時，
   只需要編輯這個檔案就好，不會動到 duel_field.html 的介面與連線邏輯。

   新增角色／卡牌／場地的步驟，請見檔案最下方的「擴充指南」註解。
   ========================================================================= */

/* =========================================================================
   PART A — 遊戲引擎（與獨立測試過的規則邏輯一致：萬用牌互動、技能升級、
   大招觸發、場地效果）。此處為單檔網頁版，直接內嵌不另外載入。
   ========================================================================= */
const HAND_SIZE = 5, MAX_AP = 3, MAX_RAGE = 100, MAX_ROUNDS = 20;

const CARD_DEFS = {
  atk_light: { id:'atk_light', name:'攻擊・輕擊', type:'universal', kind:'attack', apCost:1, distance:1, damage:10, desc:'距離1內，造成10傷害' },
  atk_heavy: { id:'atk_heavy', name:'攻擊・重擊', type:'universal', kind:'attack', apCost:2, distance:1, damage:18, desc:'距離1內，造成18傷害' },
  move:      { id:'move', name:'移動', type:'universal', kind:'move', apCost:1, moveAmount:2, needsDirection:true, desc:'靠近或遠離對手2格' },
  defend:    { id:'defend', name:'防禦', type:'universal', kind:'defend', apCost:1, reduction:0.5, desc:'本回合受到傷害減免50%' },
  dodge:     { id:'dodge', name:'迴避', type:'universal', kind:'dodge', apCost:2, desc:'完全閃避本回合受到的攻擊' },
};

const SKILL_DEFS = {
  heavy_hammer: { id:'heavy_hammer', name:'重錘擊', type:'skill', kind:'attack', apCost:2, distance:1, upgradeAt:[3,6],
    levels:[ {damage:22, effects:[]}, {damage:22, effects:[{type:'knockback',value:1}]}, {damage:22, effects:[{type:'knockback',value:1},{type:'stun',value:1}]} ],
    desc:'近距離重擊，升級後附加擊退與暈眩' },
  charge_dash: { id:'charge_dash', name:'衝撞蓄力', type:'skill', kind:'move_attack', apCost:1, moveAmount:2, direction:'approach', upgradeAt:[3,6],
    levels:[ {bonusDamage:5, condDistance:1}, {bonusDamage:7, condDistance:1}, {bonusDamage:10, condDistance:1} ],
    desc:'衝刺2格，貼近後造成額外傷害' },
  chain_stab: { id:'chain_stab', name:'連環刺', type:'skill', kind:'attack', apCost:1, distance:1, upgradeAt:[3,6],
    levels:[ {damage:8, effects:[]}, {damage:10, effects:[]}, {damage:10, effects:[{type:'rageGain',value:1}]} ],
    desc:'快速突刺，升級後傷害提升並回復怒氣' },
  afterimage_step: { id:'afterimage_step', name:'殘影步', type:'skill', kind:'move', apCost:1, moveAmount:3, direction:'retreat', upgradeAt:[3,6],
    levels:[ {effects:[{type:'untargetable'}]}, {effects:[{type:'untargetable'}]}, {effects:[{type:'untargetable'},{type:'rageGain',value:5}]} ],
    desc:'後撤3格，本回合無法被攻擊命中' },
  bind_seal: { id:'bind_seal', name:'束縛印', type:'skill', kind:'attack', apCost:2, distance:2, upgradeAt:[3,6],
    levels:[ {damage:5, effects:[{type:'bind',value:1,duration:1}]}, {damage:5, effects:[{type:'bind',value:1,duration:2}]}, {damage:5, effects:[{type:'bind',value:1,duration:2},{type:'dodgeLock',duration:2}]} ],
    desc:'命中後使對方移動距離-1，升級後延長並封鎖迴避' },
  mind_shock: { id:'mind_shock', name:'心靈震盪', type:'skill', kind:'special', apCost:1, distance:99, upgradeAt:[3,6],
    levels:[ {damage:0, effects:[{type:'lockRandomCard',value:1}]}, {damage:0, effects:[{type:'lockRandomCard',value:1}]}, {damage:0, effects:[{type:'lockRandomCard',value:2}]} ],
    desc:'使對方下回合隨機鎖定一張手牌' },
};

const ULTIMATE_DEFS = {
  earth_split: { id:'earth_split', name:'地裂衝擊', apCost:3, damage:35, ignoreDistance:true, effects:[{type:'cantMove'}],
    trigger:{type:'hpBelow', value:0.4}, desc:'HP低於40%可用：無視距離35傷害，使對方下回合無法移動' },
  afterimage_slash: { id:'afterimage_slash', name:'殘影連斬', apCost:3, hits:3, hitDamage:12, ignoreDefend:true,
    trigger:{type:'comboHits', value:3}, desc:'連續命中3回合可用：三段共36傷害，無視防禦' },
  absolute_lockdown: { id:'absolute_lockdown', name:'絕對封鎖', apCost:3, effects:[{type:'skipTurn'}],
    trigger:{type:'rage', value:100}, desc:'怒氣滿100可用：使對方下回合無法行動' },
};

const CHARACTER_DEFS = {
  rockfist: { id:'rockfist', name:'岩拳', archetype:'力量型', color:'#ff6a3d', maxHp:120,
    passive:{name:'鋼鐵之軀', desc:'受到的傷害固定減免10%', damageTakenMult:0.9},
    skillIds:['heavy_hammer','charge_dash'], ultimateId:'earth_split' },
  swiftshadow: { id:'swiftshadow', name:'疾影', archetype:'速度型', color:'#4fd6e0', maxHp:80,
    passive:{name:'瞬步', desc:'每回合第一次使用移動類卡牌不消耗AP', freeFirstMove:true},
    skillIds:['chain_stab','afterimage_step'], ultimateId:'afterimage_slash' },
  strategist: { id:'strategist', name:'謀士', archetype:'控制型', color:'#9b7fd4', maxHp:100,
    passive:{name:'洞察', desc:'被動觀察對手動向（視覺化呈現留待擴充）'},
    skillIds:['bind_seal','mind_shock'], ultimateId:'absolute_lockdown' },
};

const FIELD_DEFS = {
  plains:  { id:'plains', name:'平原擂台', size:5, desc:'標準場地，無特殊效果', effects:[] },
  volcano: { id:'volcano', name:'火山熔岩台', size:5, desc:'每滿3回合雙方各受5點灼燒傷害；移動距離-1',
    effects:[{type:'burnEveryN', n:3, value:5},{type:'moveReduce', value:1}] },
};

let _uid = 0;
function nextUid(){ return 'c'+(_uid++); }
function shuffle(arr){ const a=arr.slice(); for(let i=a.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [a[i],a[j]]=[a[j],a[i]]; } return a; }
function clamp(v,min,max){ return Math.max(min, Math.min(max, v)); }

function createPlayer(charKey, startPos, label){
  const def = CHARACTER_DEFS[charKey];
  const deckDefs = ['atk_light','atk_light','atk_heavy','atk_heavy','move','move','defend','defend','dodge'];
  def.skillIds.forEach(id=>{ deckDefs.push(id); deckDefs.push(id); });
  const deck = shuffle(deckDefs.map(defId=>({uid:nextUid(), defId})));
  const player = {
    label, charKey, name:def.name, archetype:def.archetype, color:def.color,
    maxHp:def.maxHp, hp:def.maxHp, maxAp:MAX_AP, ap:MAX_AP, rage:0,
    passive:def.passive, skillIds:def.skillIds, skillLevels:{}, skillUses:{},
    ultimateId:def.ultimateId, ultimateUnlocked:false, comboHitStreak:0,
    pos:startPos, deck, hand:[], discard:[],
    status:{ cantActNext:false,cantMoveNext:false,apReduceNext:0,lockedCardUidNext:null,lockedCardUidThisRound:null,
      bindUntilRound:0,bindValue:0,dodgeLockUntilRound:0,untargetableThisRound:false,cantActThisRound:false,cantMoveThisRound:false },
    usedFreeMoveThisRound:false,
  };
  def.skillIds.forEach(id=>{ player.skillLevels[id]=1; player.skillUses[id]=0; });
  drawToHandSize(player);
  return player;
}
function drawToHandSize(player){
  while(player.hand.length < HAND_SIZE){
    if(player.deck.length===0){ if(player.discard.length===0) break; player.deck=shuffle(player.discard); player.discard=[]; }
    player.hand.push(player.deck.pop());
  }
}
function getEffectiveCard(player, defId){
  const base = CARD_DEFS[defId] || SKILL_DEFS[defId];
  if(!base) return null;
  if(base.levels){ const lvl=player.skillLevels[defId]||1; return Object.assign({}, base, base.levels[lvl-1], {level:lvl}); }
  return Object.assign({}, base);
}
function getUltimate(player){ return Object.assign({}, ULTIMATE_DEFS[player.ultimateId]); }
function getApCost(self, card){
  const isMove = card.kind==='move' || card.kind==='move_attack';
  if(isMove && self.passive.freeFirstMove && !self.usedFreeMoveThisRound) return 0;
  return card.apCost;
}
function createGame(charKey1, charKey2, fieldKey){
  const field = Object.assign({}, FIELD_DEFS[fieldKey]);
  const p1 = createPlayer(charKey1, 1, 'P1');
  const p2 = createPlayer(charKey2, field.size, 'P2');
  return { field, round:1, p1, p2, log:[], over:false, winner:null };
}
function pushLog(game, text, cls){ game.log.push({round:game.round, text, cls:cls||''}); }
function makeNoneChoice(){ return {kind:'none', cardUid:null}; }

function applyPendingStatuses(p){
  const s=p.status;
  s.cantActThisRound = !!s.cantActNext; s.cantActNext=false;
  s.cantMoveThisRound = !!s.cantMoveNext; s.cantMoveNext=false;
  s.lockedCardUidThisRound = s.lockedCardUidNext; s.lockedCardUidNext=null;
  p.ap = Math.max(0, p.maxAp - (s.apReduceNext||0)); s.apReduceNext=0;
  p.usedFreeMoveThisRound=false; s.untargetableThisRound=false;
}
function resolveChoiceInfo(self, choice){
  if(!choice || choice.kind==='none') return {kind:'none', name:'（未行動）'};
  if(choice.kind==='ultimate'){ const ult=getUltimate(self); return {kind:'ultimate', def:ult, name:ult.name}; }
  if(!choice.cardUid) return {kind:'none', name:'（未行動）'};
  const cardInHand = self.hand.find(c=>c.uid===choice.cardUid);
  if(!cardInHand) return {kind:'none', name:'（未行動）'};
  const card = getEffectiveCard(self, cardInHand.defId);
  return { kind:card.type, defId:cardInHand.defId, cardUid:choice.cardUid, card, direction:choice.direction, name:card.name, dealt:0 };
}
function markRoundFlags(self, info){
  if(info.kind==='skill' && info.card && info.card.effects){
    info.card.effects.forEach(eff=>{ if(eff.type==='untargetable') self.status.untargetableThisRound=true; });
  }
}
function applyMovement(game, self, opp, info){
  if(info.kind==='none' || info.kind==='ultimate') return;
  const card = info.card;
  const isMove = card.kind==='move' || card.kind==='move_attack';
  if(!isMove) return;
  if(self.status.cantMoveThisRound){ pushLog(game, `${self.label} 的移動被封鎖，無法移動。`); return; }
  let amount = card.moveAmount;
  const fr = (game.field.effects||[]).find(e=>e.type==='moveReduce');
  if(fr) amount = Math.max(0, amount - fr.value);
  if(self.status.bindUntilRound && game.round<=self.status.bindUntilRound) amount = Math.max(0, amount - self.status.bindValue);
  const direction = card.direction || info.direction || 'approach';
  const towardOpp = opp.pos>self.pos?1:(opp.pos<self.pos?-1:1);
  const sign = direction==='approach'?towardOpp:-towardOpp;
  self.pos = clamp(self.pos + sign*amount, 1, game.field.size);
}
function applyEffect(game, self, opp, eff){
  switch(eff.type){
    case 'knockback': { const dir=opp.pos>=self.pos?1:-1; opp.pos=clamp(opp.pos+dir*eff.value,1,game.field.size); pushLog(game, `${opp.label} 被擊退至第 ${opp.pos} 格。`); break; }
    case 'stun': opp.status.apReduceNext=(opp.status.apReduceNext||0)+eff.value; pushLog(game, `${opp.label} 被擊暈，下回合 AP -${eff.value}。`); break;
    case 'bind': opp.status.bindUntilRound=game.round+eff.duration; opp.status.bindValue=eff.value; pushLog(game, `${opp.label} 被束縛，移動距離-${eff.value}（持續${eff.duration}回合）。`); break;
    case 'dodgeLock': opp.status.dodgeLockUntilRound=game.round+eff.duration; pushLog(game, `${opp.label} 的迴避被封鎖（持續${eff.duration}回合）。`); break;
    case 'rageGain': self.rage=clamp(self.rage+eff.value,0,MAX_RAGE); break;
    case 'cantMove': opp.status.cantMoveNext=true; pushLog(game, `${opp.label} 下回合無法移動。`); break;
    case 'skipTurn': opp.status.cantActNext=true; pushLog(game, `${opp.label} 下回合無法行動。`); break;
  }
}
function applyAttack(game, self, opp, info, oppInfo, distance){
  if(info.kind==='none') return;
  let damage=0, ignoreDistance=false, ignoreDefend=false, requiredDistance=null, effects=[];
  if(info.kind==='ultimate'){
    const ult=info.def;
    if(!ult.damage && !ult.hits){ (ult.effects||[]).forEach(eff=>applyEffect(game,self,opp,eff)); return; }
    ignoreDistance=!!ult.ignoreDistance; ignoreDefend=!!ult.ignoreDefend;
    damage = ult.damage || (ult.hits*ult.hitDamage);
    requiredDistance = ignoreDistance?Infinity:1; effects=ult.effects||[];
  } else {
    const card=info.card;
    if(card.kind==='attack'){ damage=card.damage; requiredDistance=card.distance; effects=card.effects||[]; }
    else if(card.kind==='move_attack'){
      if(distance<=(card.condDistance||1)){ damage=card.bonusDamage; requiredDistance=card.condDistance||1; effects=card.effects||[]; }
      else { pushLog(game, `${self.label} 使用「${card.name}」衝刺，但距離不足，沒有額外傷害。`); return; }
    } else return;
  }
  if(damage<=0) return;
  if(!ignoreDistance && distance>requiredDistance){ pushLog(game, `${self.label} 的「${info.name}」距離不足（需要≤${requiredDistance}，目前${distance}），未命中。`); return; }
  if(opp.status.untargetableThisRound){ pushLog(game, `${self.label} 的攻擊被 ${opp.label}（殘影步）完全躲開！`); return; }
  const oppDodge = oppInfo.kind==='universal' && oppInfo.card && oppInfo.card.kind==='dodge';
  const dodgeDisabled = opp.status.dodgeLockUntilRound && game.round<=opp.status.dodgeLockUntilRound;
  if(oppDodge && !dodgeDisabled){ pushLog(game, `${self.label} 的攻擊被 ${opp.label} 完全閃避！`); return; }
  if(oppDodge && dodgeDisabled){ pushLog(game, `${opp.label} 試圖迴避，但效果被封鎖，依然受到攻擊！`); }
  let finalDamage=damage;
  const oppDefend = oppInfo.kind==='universal' && oppInfo.card && oppInfo.card.kind==='defend';
  if(oppDefend && !ignoreDefend) finalDamage *= (1-oppInfo.card.reduction);
  if(opp.passive.damageTakenMult) finalDamage *= opp.passive.damageTakenMult;
  finalDamage = Math.round(finalDamage);
  opp.hp = clamp(opp.hp - finalDamage, 0, opp.maxHp);
  info.dealt = finalDamage;
  pushLog(game, `${self.label} 的「${info.name}」命中 ${opp.label}，造成 ${finalDamage} 傷害！（剩餘HP：${opp.hp}）`, 'l-hit');
  self.rage = clamp(self.rage + Math.round(finalDamage*0.5), 0, MAX_RAGE);
  opp.rage = clamp(opp.rage + Math.round(finalDamage*0.3), 0, MAX_RAGE);
  effects.forEach(eff=>applyEffect(game,self,opp,eff));
}
function applySpecial(game, self, opp, info){
  if(info.kind!=='skill' || !info.card || info.card.kind!=='special') return;
  (info.card.effects||[]).forEach(eff=>{
    if(eff.type==='lockRandomCard' && opp.hand.length>0){
      const idx=Math.floor(Math.random()*opp.hand.length);
      opp.status.lockedCardUidNext = opp.hand[idx].uid;
      pushLog(game, `${self.label} 使用「心靈震盪」，鎖定了 ${opp.label} 下回合的一張手牌。`);
    }
  });
}
function checkUpgrade(game, player, info){
  if(info.kind!=='skill' || !info.defId) return;
  const def=SKILL_DEFS[info.defId];
  if(!def || !def.upgradeAt) return;
  player.skillUses[info.defId]=(player.skillUses[info.defId]||0)+1;
  const uses=player.skillUses[info.defId];
  const curLevel=player.skillLevels[info.defId]||1;
  if(curLevel<3 && uses>=def.upgradeAt[curLevel-1]){
    player.skillLevels[info.defId]=curLevel+1;
    pushLog(game, `✨ ${player.label} 的「${def.name}」升級至 Lv.${curLevel+1}！`, 'l-up');
  }
}
function updateComboStreak(player, info){
  if(info.kind==='skill' && info.dealt>0) player.comboHitStreak+=1;
  else if(info.kind!=='none') player.comboHitStreak=0;
}
function discardAndRefill(player, info){
  if(info.kind==='universal' || info.kind==='skill'){
    const idx=player.hand.findIndex(c=>c.uid===info.cardUid);
    if(idx>=0){ const [card]=player.hand.splice(idx,1); player.discard.push(card); }
  } else if(info.kind==='ultimate'){
    player.ultimateUnlocked=false;
    if(player.ultimateId==='absolute_lockdown') player.rage=0;
    if(player.ultimateId==='afterimage_slash') player.comboHitStreak=0;
  }
  drawToHandSize(player);
}
function applyFieldEffects(game){
  const burn=(game.field.effects||[]).find(e=>e.type==='burnEveryN');
  if(burn && game.round%burn.n===0){
    [game.p1, game.p2].forEach(p=>{ p.hp=clamp(p.hp-burn.value,0,p.maxHp); pushLog(game, `${game.field.name} 的灼燒效果使 ${p.label} 受到 ${burn.value} 傷害。（剩餘HP：${p.hp}）`); });
  }
}
function checkUltimateUnlock(game, player){
  if(player.ultimateUnlocked) return;
  const ult=ULTIMATE_DEFS[player.ultimateId]; const t=ult.trigger; let met=false;
  if(t.type==='hpBelow') met = player.hp<=player.maxHp*t.value;
  if(t.type==='rage') met = player.rage>=t.value;
  if(t.type==='comboHits') met = player.comboHitStreak>=t.value;
  if(met){ player.ultimateUnlocked=true; pushLog(game, `🔥 ${player.label} 的大招「${ult.name}」已解鎖！`, 'l-up'); }
}
function checkWin(game){
  if(game.p1.hp<=0 && game.p2.hp<=0){ game.over=true; game.winner='draw'; pushLog(game,'雙方同時倒下，本場平手！'); }
  else if(game.p1.hp<=0){ game.over=true; game.winner='p2'; pushLog(game, `${game.p2.label}（${game.p2.name}）獲勝！`); }
  else if(game.p2.hp<=0){ game.over=true; game.winner='p1'; pushLog(game, `${game.p1.label}（${game.p1.name}）獲勝！`); }
}
function finishByHp(game){
  game.over=true;
  if(game.p1.hp===game.p2.hp) game.winner='draw'; else game.winner = game.p1.hp>game.p2.hp?'p1':'p2';
  const who = game.winner==='draw'?'平手':((game.winner==='p1'?game.p1.label:game.p2.label)+' 獲勝');
  pushLog(game, `已達回合上限，依剩餘HP判定：${who}`);
}
function resolveRound(game, choice1, choice2){
  const {p1,p2}=game;
  pushLog(game, `--- 第 ${game.round} 回合 ---`, 'l-round');
  applyPendingStatuses(p1); applyPendingStatuses(p2);
  if(p1.status.cantActThisRound) pushLog(game, `${p1.label}（${p1.name}）被封鎖，本回合無法行動。`);
  if(p2.status.cantActThisRound) pushLog(game, `${p2.label}（${p2.name}）被封鎖，本回合無法行動。`);
  const info1 = p1.status.cantActThisRound ? resolveChoiceInfo(p1, makeNoneChoice()) : resolveChoiceInfo(p1, choice1);
  const info2 = p2.status.cantActThisRound ? resolveChoiceInfo(p2, makeNoneChoice()) : resolveChoiceInfo(p2, choice2);
  markRoundFlags(p1, info1); markRoundFlags(p2, info2);
  applyMovement(game,p1,p2,info1); applyMovement(game,p2,p1,info2);
  const distance = Math.abs(p1.pos-p2.pos);
  pushLog(game, `場上距離：${distance} 格（${p1.label} 在第${p1.pos}格，${p2.label} 在第${p2.pos}格）`);
  applyAttack(game,p1,p2,info1,info2,distance); applyAttack(game,p2,p1,info2,info1,distance);
  applySpecial(game,p1,p2,info1); applySpecial(game,p2,p1,info2);
  checkUpgrade(game,p1,info1); checkUpgrade(game,p2,info2);
  updateComboStreak(p1,info1); updateComboStreak(p2,info2);
  discardAndRefill(p1,info1); discardAndRefill(p2,info2);
  applyFieldEffects(game);
  checkUltimateUnlock(game,p1); checkUltimateUnlock(game,p2);
  checkWin(game);
  if(!game.over){ game.round+=1; if(game.round>MAX_ROUNDS) finishByHp(game); }
  return {distance, info1, info2};
}

// ---- 讓這個檔案同時可以被 Node.js (測試用) 與瀏覽器 (網頁版) 使用 ----
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    CARD_DEFS, SKILL_DEFS, ULTIMATE_DEFS, CHARACTER_DEFS, FIELD_DEFS,
    createGame, resolveRound, getEffectiveCard, getUltimate, getApCost,
    HAND_SIZE, MAX_AP, MAX_RAGE, MAX_ROUNDS,
  };
}

/* =========================================================================
   擴充指南（新增角色 / 卡牌 / 場地時請參考這裡）
   -------------------------------------------------------------------------
   1. 新增一張「萬用牌」：
      在 CARD_DEFS 裡新增一筆，例如：
        my_card: { id:'my_card', name:'卡牌名稱', type:'universal',
                    kind:'attack'|'move'|'defend'|'dodge', apCost:1,
                    distance:1, damage:10, desc:'說明文字' }
      萬用牌目前不支援升級，所有角色共用。

   2. 新增一張「角色技能牌」（可升級）：
      在 SKILL_DEFS 裡新增一筆，至少要有 levels 陣列（固定3個等級物件，
      對應 Lv1/Lv2/Lv3），以及 upgradeAt（兩個數字，分別是升到Lv2、Lv3
      所需的使用次數）。kind 可以是 attack / move / move_attack / special。
      effects 陣列可用的效果代碼：knockback（擊退）、stun（下回合AP-N）、
      bind（束縛，降低對方移動距離並可持續多回合）、dodgeLock（封鎖對方
      迴避效果）、rageGain（直接獲得怒氣）、cantMove（下回合無法移動）、
      skipTurn（下回合無法行動）、untargetable（本回合不會被攻擊命中）、
      lockRandomCard（鎖定對方一張隨機手牌）。

   3. 新增一個「大招牌」：
      在 ULTIMATE_DEFS 裡新增一筆，trigger 可以是：
        { type:'hpBelow', value:0.4 }   → HP低於該比例時解鎖
        { type:'rage', value:100 }      → 怒氣值達到該數值時解鎖
        { type:'comboHits', value:3 }   → 連續N回合命中技能牌時解鎖
      傷害型大招用 damage 或 hits+hitDamage；控制型大招只給 effects。

   4. 新增一個「角色」：
      在 CHARACTER_DEFS 裡新增一筆，填入 maxHp、passive（被動，目前支援
      damageTakenMult 減傷倍率 / freeFirstMove 移動類卡牌首次免AP，其他
      被動效果需另外在引擎程式碼裡實作判斷)、skillIds（對應兩張在
      SKILL_DEFS 定義好的技能牌id）、ultimateId（對應一張在 ULTIMATE_DEFS
      定義好的大招id）。

   5. 新增一個「場地」：
      在 FIELD_DEFS 裡新增一筆，size 是場地格數，effects 目前支援：
        { type:'burnEveryN', n:3, value:5 }  → 每N回合雙方各受value點傷害
        { type:'moveReduce', value:1 }       → 所有移動類卡牌距離-value

   新增完資料後，duel_field.html 的角色卡片、場地卡片、出牌畫面都會
   自動讀取 CHARACTER_DEFS / FIELD_DEFS / SKILL_DEFS 產生，不需要再去
   改 HTML。如果新增的是「全新效果類型」（上面列的效果代碼沒有涵蓋到的
   行為），才需要到 applyEffect() 函式裡新增一個 case。
   ========================================================================= */
