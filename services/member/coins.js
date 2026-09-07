'use strict';
const s = require('./store');
const SCALE = 1000000n;
function Units(value, decimals) {
    const text = String(value ?? '').trim();
    if (!/^\d{1,18}(?:\.\d{1,18})?$/.test(text)) s.Fail('COIN_AMOUNT_INVALID');
    const [whole, fraction = ''] = text.split('.');
    if (fraction.length > decimals) s.Fail('COIN_AMOUNT_INVALID');
    return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, '0') || '0');
}
function Decimal(units, decimals) {
    const digits = units.toString().padStart(decimals + 1, '0');
    if (!decimals) return digits;
    const fraction = digits.slice(-decimals).replace(/0+$/, '');
    return digits.slice(0, -decimals) + (fraction ? '.' + fraction : '');
}
function List() { return Object.values(s.DB().coins).filter(c => c.enabled && !c.deleted).sort((a,b) => a.symbol.localeCompare(b.symbol) || a.network.localeCompare(b.network)); }
function Save(body) {
    const id = body.id ? s.Text(body.id,40) : s.Id('COIN');
    const previous = s.DB().coins[id];
    if (body.id && !previous) s.Fail('COIN_NOT_FOUND');
    const symbol = s.Text(body.symbol,12,true).toUpperCase();
    if (!/^[A-Z0-9]{2,12}$/.test(symbol)) s.Fail('INPUT_INVALID');
    const address = s.Text(body.address,200,true);
    if (!/^[A-Za-z0-9:_-]{12,200}$/.test(address)) s.Fail('COIN_ADDRESS_INVALID');
    const rate = Units(body.krwPerCoin,6);
    if (rate <= 0n || rate > 1000000000000n * SCALE) s.Fail('COIN_RATE_INVALID');
    const row = {id,symbol,name:s.Text(body.name,40,true),network:s.Text(body.network,40,true),address,memo:s.Text(body.memo,100),
        decimals:s.Money(body.decimals,0,18),krwPerCoin:Decimal(rate,6),confirmations:s.Money(body.confirmations,1,10000),
        enabled:body.enabled===true,deleted:previous?.deleted||false,revision:(previous?.revision||0)+1,updatedAt:Date.now()};
    if (previous && body.revision !== undefined && body.revision !== previous.revision) s.Fail('CONTENT_CHANGED');
    return s.Atomic(() => { s.DB().coins[id]=row; return row; });
}
function AddressQr(address) {
    // Short addresses need enough modules to tolerate the existing 9-module logo.
    const QRCode=require('qrcode'),options={errorCorrectionLevel:'H'};
    let qr=QRCode.create(address,options);
    if(qr.modules.size<37)qr=QRCode.create(address,{...options,version:5});
    return {size:qr.modules.size,bits:Array.from(qr.modules.data,x=>x?'1':'0').join('')};
}
function Quote(p,body) {
    if (!s.DB().settings.topupEnabled) s.Fail('TOPUP_UNAVAILABLE');
    const coin = s.DB().coins[body.coinId];
    if (!coin || !coin.enabled || coin.deleted) s.Fail('COIN_UNAVAILABLE');
    const amount = s.Money(body.amount,1000,1000000), now=Date.now();
    const rate = Units(coin.krwPerCoin,6), numerator = BigInt(amount) * 10n ** BigInt(coin.decimals) * SCALE;
    const units = (numerator + rate - 1n) / rate;
    const quote = {id:s.Id('QUOTE'),accountId:p.id,amount,coin:structuredClone(coin),coinAmount:Decimal(units,coin.decimals),
        at:now,expiresAt:now+15*60*1000,usedBy:''};
    // Bound abandoned quotes per account without deleting accepted deposit evidence.
    for (const q of Object.values(s.DB().quotes)) if(q.accountId===p.id&&!q.usedBy) delete s.DB().quotes[q.id];
    s.DB().quotes[quote.id]=quote;
    return {quote:{...quote,qr:AddressQr(coin.address)},balance:p.balance};
}
function TxKey(value) {
    const tx = s.Text(value,200,true);
    if (!/^[A-Za-z0-9]{12,200}$/.test(tx)) s.Fail('TX_HASH_INVALID');
    return /^(?:0x)?[0-9a-f]+$/i.test(tx) ? tx.replace(/^0x/i,'').toLowerCase() : tx;
}
function Request(p,body) {
    if (!s.DB().settings.topupEnabled) s.Fail('TOPUP_UNAVAILABLE');
    const quote = s.DB().quotes[body.quoteId];
    if (!quote || quote.accountId!==p.id) s.Fail('QUOTE_NOT_FOUND');
    if (quote.expiresAt<=Date.now()) s.Fail('QUOTE_EXPIRED');
    if (quote.usedBy) s.Fail('QUOTE_ALREADY_USED');
    if(Object.values(s.DB().topups).filter(t=>t.accountId===p.id&&t.status==='PENDING').length>=3)s.Fail('TOPUP_PENDING_LIMIT');
    const txHash=s.Text(body.txHash,200,true),txKey=TxKey(txHash);
    // A submitted transaction stays reserved even after cancellation/rejection;
    // it can be reviewed by an administrator, never credited a second time.
    if (Object.values(s.DB().topups).some(t=>t.txKey===txKey)) s.Fail('TX_ALREADY_SUBMITTED');
    const id=s.Id('TOP'),row={id,accountId:p.id,amount:quote.amount,quoteId:quote.id,coin:structuredClone(quote.coin),coinAmount:quote.coinAmount,
        txHash,txKey,note:s.Text(body.note,150),status:'PENDING',at:Date.now(),processedAt:0,processedBy:'',reason:''};
    s.DB().topups[id]=row;quote.usedBy=id;
    return {topup:row,balance:p.balance};
}
function CheckReceipt(row,body) {
    if (!row.coin) return {}; // Existing FIX13 pending deposits remain reviewable.
    const received = Units(body.receivedAmount,row.coin.decimals);
    const confirmations = s.Money(body.confirmations,0,1000000);
    if (received < Units(row.coinAmount,row.coin.decimals)) s.Fail('COIN_AMOUNT_SHORT');
    if (confirmations < row.coin.confirmations) s.Fail('CONFIRMATIONS_SHORT');
    if (body.receiptVerified !== true) s.Fail('RECEIPT_VERIFICATION_REQUIRED');
    return {receivedAmount:Decimal(received,row.coin.decimals),confirmations,receiptVerified:true};
}
module.exports={Units,Decimal,List,Save,AddressQr,Quote,Request,CheckReceipt,TxKey};
