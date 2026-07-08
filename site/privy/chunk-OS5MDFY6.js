import{a as br}from"./chunk-KR7N2OOI.js";import{a as xr}from"./chunk-T7TV7N5Z.js";import{a as vr}from"./chunk-TUYB6ZKQ.js";import{a as kr}from"./chunk-5CCK2LWZ.js";import{a as b}from"./chunk-OZ5DZKV5.js";import{a as X,b as ur}from"./chunk-NFZ4S3E7.js";import{a as gr}from"./chunk-FZRLKM4J.js";import{b as pr}from"./chunk-O6F4VE74.js";import{a as er}from"./chunk-JW2CSC7N.js";import{a as nr}from"./chunk-WRGK3WEC.js";import{b as yr}from"./chunk-VG5ZWMSY.js";import{a as Z}from"./chunk-K2TIDX5Z.js";import{a as D}from"./chunk-LRGIVOAE.js";import{a as S,b as n,c as i,d as fr,e as o}from"./chunk-HGH6IKIA.js";import{a as rr}from"./chunk-ZCN2V5V3.js";import{a}from"./chunk-TF4QA2ZZ.js";import{a as cr,d as _,e as hr,g as z,l as mr,m as U}from"./chunk-3TPGN3TC.js";import{Wa as d,_a as Y,e as dr}from"./chunk-UGSP3DD6.js";import{X as sr,ab as K,ra as J}from"./chunk-OV7GNHZT.js";import{a as Kr,b as Yr}from"./chunk-RYBZHIKX.js";import{Fa as ar}from"./chunk-LYIDHH4Z.js";import{e as lr}from"./chunk-3IKZH76S.js";var r=lr(Yr(),1);var W=lr(Kr(),1);var Or=d(i)`
  cursor: pointer;
  display: inline-flex;
  gap: 8px;
  align-items: center;
  color: var(--privy-color-accent);
  svg {
    fill: var(--privy-color-accent);
  }
`,wr=({iconUrl:s,value:c,symbol:l,usdValue:u,nftName:T,nftCount:g,decimals:t,$isLoading:p})=>{if(p)return(0,r.jsx)(Tr,{$isLoading:p});let y=c&&u&&t?function(I,$,O){let A=parseFloat(I),m=parseFloat(O);if(A===0||m===0||Number.isNaN(A)||Number.isNaN(m))return I;let v=Math.ceil(-Math.log10(.01/(m/A))),k=Math.pow(10,v=Math.max(v=Math.min(v,$),1)),C=+(Math.floor(A*k)/k).toFixed(v).replace(/\.?0+$/,"");return Intl.NumberFormat(void 0,{maximumFractionDigits:$}).format(C)}(c,t,u):c;return(0,r.jsxs)("div",{children:[(0,r.jsxs)(Tr,{$isLoading:p,children:[s&&(0,r.jsx)(Xr,{src:s,alt:"Token icon"}),g&&g>1?g+"x":void 0," ",T,y," ",l]}),u&&(0,r.jsxs)(_r,{$isLoading:p,children:["$",u]})]})},Tr=d.span`
  color: var(--privy-color-foreground);
  font-size: 0.875rem;
  font-weight: 500;
  line-height: 1.375rem;
  word-break: break-all;
  text-align: right;
  display: flex;
  justify-content: flex-end;

  ${rr}
`,_r=d.span`
  color: var(--privy-color-foreground-2);
  font-size: 12px;
  font-weight: 400;
  line-height: 18px;
  word-break: break-all;
  text-align: right;
  display: flex;
  justify-content: flex-end;

  ${rr}
`,Xr=d.img`
  height: 14px;
  width: 14px;
  margin-right: 4px;
  object-fit: contain;
`,Zr=s=>{let{chain:c,transactionDetails:l,isTokenContractInfoLoading:u,symbol:T}=s,{action:g,functionName:t}=l;return(0,r.jsx)(yr,{children:(0,r.jsxs)(S,{children:[g!=="transaction"&&(0,r.jsxs)(n,{children:[(0,r.jsx)(i,{children:"Action"}),(0,r.jsx)(o,{children:t})]}),t==="mint"&&"args"in l&&l.args.filter(p=>p).map((p,y)=>(0,r.jsxs)(n,{children:[(0,r.jsx)(i,{children:`Param ${y}`}),(0,r.jsx)(o,{children:typeof p=="string"&&ar(p)?(0,r.jsx)(a,{address:p,url:c?.blockExplorers?.default?.url,showCopyIcon:!1}):p?.toString()})]},y)),t==="setApprovalForAll"&&l.operator&&(0,r.jsxs)(n,{children:[(0,r.jsx)(i,{children:"Operator"}),(0,r.jsx)(o,{children:(0,r.jsx)(a,{address:l.operator,url:c?.blockExplorers?.default?.url,showCopyIcon:!1})})]}),t==="setApprovalForAll"&&l.approved!==void 0&&(0,r.jsxs)(n,{children:[(0,r.jsx)(i,{children:"Set approval to"}),(0,r.jsx)(o,{children:l.approved?"true":"false"})]}),t==="transfer"||t==="transferWithMemo"||t==="transferFrom"||t==="safeTransferFrom"||t==="approve"?(0,r.jsxs)(r.Fragment,{children:["formattedAmount"in l&&l.formattedAmount&&(0,r.jsxs)(n,{children:[(0,r.jsx)(i,{children:"Amount"}),(0,r.jsxs)(o,{$isLoading:u,children:[l.formattedAmount," ",T]})]}),"tokenId"in l&&l.tokenId&&(0,r.jsxs)(n,{children:[(0,r.jsx)(i,{children:"Token ID"}),(0,r.jsx)(o,{children:l.tokenId.toString()})]})]}):null,t==="safeBatchTransferFrom"&&(0,r.jsxs)(r.Fragment,{children:["amounts"in l&&l.amounts&&(0,r.jsxs)(n,{children:[(0,r.jsx)(i,{children:"Amounts"}),(0,r.jsx)(o,{children:l.amounts.join(", ")})]}),"tokenIds"in l&&l.tokenIds&&(0,r.jsxs)(n,{children:[(0,r.jsx)(i,{children:"Token IDs"}),(0,r.jsx)(o,{children:l.tokenIds.join(", ")})]})]}),t==="approve"&&l.spender&&(0,r.jsxs)(n,{children:[(0,r.jsx)(i,{children:"Spender"}),(0,r.jsx)(o,{children:(0,r.jsx)(a,{address:l.spender,url:c?.blockExplorers?.default?.url,showCopyIcon:!1})})]}),(t==="transferFrom"||t==="safeTransferFrom"||t==="safeBatchTransferFrom")&&l.transferFrom&&(0,r.jsxs)(n,{children:[(0,r.jsx)(i,{children:"Transferring from"}),(0,r.jsx)(o,{children:(0,r.jsx)(a,{address:l.transferFrom,url:c?.blockExplorers?.default?.url,showCopyIcon:!1})})]}),(t==="transferFrom"||t==="safeTransferFrom"||t==="safeBatchTransferFrom")&&l.transferTo&&(0,r.jsxs)(n,{children:[(0,r.jsx)(i,{children:"Transferring to"}),(0,r.jsx)(o,{children:(0,r.jsx)(a,{address:l.transferTo,url:c?.blockExplorers?.default?.url,showCopyIcon:!1})})]})]})})},re=({variant:s,setPreventMaliciousTransaction:c,colorScheme:l="light",preventMaliciousTransaction:u})=>s==="warn"?(0,r.jsx)(Ir,{children:(0,r.jsxs)(xr,{theme:l,children:[(0,r.jsx)("span",{style:{fontWeight:"500"},children:"Warning: Suspicious transaction"}),(0,r.jsx)("br",{}),"This has been flagged as a potentially deceptive request. Approving could put your assets or funds at risk."]})}):s==="error"?(0,r.jsx)(r.Fragment,{children:(0,r.jsxs)(Ir,{children:[(0,r.jsx)(br,{theme:l,children:(0,r.jsxs)("div",{children:[(0,r.jsx)("strong",{children:"This is a malicious transaction"}),(0,r.jsx)("br",{}),"This transaction transfers tokens to a known malicious address. Proceeding may result in the loss of valuable assets."]})}),(0,r.jsxs)(ee,{children:[(0,r.jsx)(vr,{color:"var(--privy-color-error)",checked:!u,readOnly:!0,onClick:()=>c(!u)}),(0,r.jsx)("span",{children:"I understand and want to proceed anyways."})]})]})}):null,Ir=d.div`
  margin-top: 1.5rem;
`,ee=d.div`
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-top: 0.75rem;
`,ne=({transactionIndex:s,maxIndex:c})=>typeof s!="number"||c===0?"":` (${s+1} / ${c+1})`,Ue=({img:s,submitError:c,prepareError:l,onClose:u,action:T,title:g,subtitle:t,to:p,tokenAddress:y,network:I,missingFunds:$,fee:O,from:A,cta:m,disabled:v,chain:k,isSubmitting:C,isPreparing:f,isTokenPriceLoading:E,isTokenContractInfoLoading:L,isSponsored:j,symbol:R,balance:P,onClick:N,transactionDetails:M,transactionIndex:B,maxIndex:V,onBack:e,chainName:x,validation:q,hasScanDetails:ir,setIsScanDetailsOpen:Lr,preventMaliciousTransaction:jr,setPreventMaliciousTransaction:Pr,tokensSent:or,tokensReceived:H,isScanning:Br,isCancellable:zr,functionName:Ur})=>{let{showTransactionDetails:Q,setShowTransactionDetails:Wr,hasMoreDetails:Rr,isErc20Ish:Vr}=(h=>{let[F,Qr]=(0,W.useState)(!1),G=!0,tr=!1;return(!h||h.isErc20Ish||h.action==="transaction")&&(G=!1),G&&(tr=Object.entries(h||{}).some(([Gr,Jr])=>Jr&&!["action","isErc20Ish","isNFTIsh"].includes(Gr))),{showTransactionDetails:F,setShowTransactionDetails:Qr,hasMoreDetails:G&&tr,isErc20Ish:h?.isErc20Ish}})(M),qr=K(),Hr=Vr&&L||f||E||Br;return(0,r.jsxs)(r.Fragment,{children:[(0,r.jsx)(U,{onClose:u,backFn:e}),s&&(0,r.jsx)(Fr,{children:s}),(0,r.jsxs)(nr,{style:{marginTop:s?"1.5rem":0},children:[g,(0,r.jsx)(ne,{maxIndex:V,transactionIndex:B})]}),(0,r.jsx)(er,{children:t}),(0,r.jsxs)(S,{style:{marginTop:"2rem"},children:[(!!or[0]||Hr)&&(0,r.jsxs)(n,{children:[H.length>0?(0,r.jsx)(i,{children:"Send"}):(0,r.jsx)(i,{children:T==="approve"?"Approval amount":"Amount"}),(0,r.jsx)("div",{className:"flex flex-col",children:or.map((h,F)=>(0,r.jsx)(wr,{iconUrl:h.iconUrl,value:Ur==="setApprovalForAll"?"All":h.value,usdValue:h.usdValue,symbol:h.symbol,nftName:h.nftName,nftCount:h.nftCount,decimals:h.decimals},F))})]}),H.length>0&&(0,r.jsxs)(n,{children:[(0,r.jsx)(i,{children:"Receive"}),(0,r.jsx)("div",{className:"flex flex-col",children:H.map((h,F)=>(0,r.jsx)(wr,{iconUrl:h.iconUrl,value:h.value,usdValue:h.usdValue,symbol:h.symbol,nftName:h.nftName,nftCount:h.nftCount,decimals:h.decimals},F))})]}),M&&"spender"in M&&M?.spender?(0,r.jsxs)(n,{children:[(0,r.jsx)(i,{children:"Spender"}),(0,r.jsx)(o,{children:(0,r.jsx)(a,{address:M.spender,url:k?.blockExplorers?.default?.url})})]}):null,p&&(0,r.jsxs)(n,{children:[(0,r.jsx)(i,{children:"To"}),(0,r.jsx)(o,{children:(0,r.jsx)(a,{address:p,url:k?.blockExplorers?.default?.url,showCopyIcon:!0})})]}),y&&(0,r.jsxs)(n,{children:[(0,r.jsx)(i,{children:"Token address"}),(0,r.jsx)(o,{children:(0,r.jsx)(a,{address:y,url:k?.blockExplorers?.default?.url})})]}),(0,r.jsxs)(n,{children:[(0,r.jsx)(i,{children:"Network"}),(0,r.jsx)(o,{children:I})]}),(0,r.jsxs)(n,{children:[(0,r.jsx)(i,{children:"Estimated fee"}),(0,r.jsx)(o,{$isLoading:f||E||j===void 0,children:j?(0,r.jsxs)(Dr,{children:[(0,r.jsxs)(Sr,{children:["Sponsored by ",qr.name]}),(0,r.jsx)(X,{height:16,width:16})]}):O})]}),Rr&&!ir&&(0,r.jsxs)(r.Fragment,{children:[(0,r.jsx)(n,{className:"cursor-pointer",onClick:()=>Wr(!Q),children:(0,r.jsxs)(fr,{className:"flex items-center gap-x-1",children:["Details"," ",(0,r.jsx)(Z,{style:{width:"0.75rem",marginLeft:"0.25rem",transform:Q?"rotate(180deg)":void 0}})]})}),Q&&M&&(0,r.jsx)(Zr,{action:T,chain:k,transactionDetails:M,isTokenContractInfoLoading:L,symbol:R})]}),ir&&(0,r.jsx)(n,{children:(0,r.jsxs)(Or,{onClick:()=>Lr(!0),children:[(0,r.jsx)("span",{className:"text-color-primary",children:"Details"}),(0,r.jsx)(cr,{height:"14px",width:"14px",strokeWidth:"2"})]})})]}),(0,r.jsx)(Y,{}),c?(0,r.jsx)(D,{style:{marginTop:"2rem"},children:c.message}):l&&B===0?(0,r.jsx)(D,{style:{marginTop:"2rem"},children:l.shortMessage??Nr}):null,(0,r.jsx)(re,{variant:q,preventMaliciousTransaction:jr,setPreventMaliciousTransaction:Pr}),(0,r.jsx)(Er,{$useSmallMargins:!(!l&&!c&&q!=="warn"&&q!=="error"),address:A,balance:P,errMsg:f||l||c||!$?void 0:`Add funds on ${k?.name??x} to complete transaction.`}),(0,r.jsx)(z,{style:{marginTop:"1rem"},loading:C,disabled:v||f,onClick:N,children:m}),zr&&(0,r.jsx)(mr,{style:{marginTop:"1rem"},onClick:u,isSubmitting:!1,children:"Not now"}),(0,r.jsx)(_,{})]})},We=({img:s,title:c,subtitle:l,cta:u,instructions:T,network:g,blockExplorerUrl:t,isMissingFunds:p,submitError:y,parseError:I,total:$,swap:O,transactingWalletAddress:A,fee:m,balance:v,disabled:k,isSubmitting:C,isPreparing:f,isTokenPriceLoading:E,onClick:L,onClose:j,onBack:R,isSponsored:P})=>{let N=f||E,[M,B]=(0,W.useState)(!1),V=K();return(0,r.jsxs)(r.Fragment,{children:[(0,r.jsx)(U,{onClose:j,backFn:R}),s&&(0,r.jsx)(Fr,{children:s}),(0,r.jsx)(nr,{style:{marginTop:s?"1.5rem":0},children:c}),(0,r.jsx)(er,{children:l}),(0,r.jsxs)(S,{style:{marginTop:"2rem",marginBottom:".5rem"},children:[($||N)&&(0,r.jsxs)(n,{children:[(0,r.jsx)(i,{children:"Amount"}),(0,r.jsx)(o,{$isLoading:N,children:$})]}),O&&(0,r.jsxs)(n,{children:[(0,r.jsx)(i,{children:"Swap"}),(0,r.jsx)(o,{children:O})]}),g&&(0,r.jsxs)(n,{children:[(0,r.jsx)(i,{children:"Network"}),(0,r.jsx)(o,{children:g})]}),(m||N||P!==void 0)&&(0,r.jsxs)(n,{children:[(0,r.jsx)(i,{children:"Estimated fee"}),(0,r.jsx)(o,{$isLoading:N,children:P&&!N?(0,r.jsxs)(Dr,{children:[(0,r.jsxs)(Sr,{children:["Sponsored by ",V.name]}),(0,r.jsx)(X,{height:16,width:16})]}):m})]})]}),(0,r.jsx)(n,{children:(0,r.jsxs)(Or,{onClick:()=>B(e=>!e),children:[(0,r.jsx)("span",{children:"Advanced"}),(0,r.jsx)(Z,{height:"16px",width:"16px",strokeWidth:"2",style:{transition:"all 300ms",transform:M?"rotate(180deg)":void 0}})]})}),M&&(0,r.jsx)(r.Fragment,{children:T.map((e,x)=>e.type==="sol-transfer"?(0,r.jsxs)(w,{children:[(0,r.jsx)(n,{children:(0,r.jsxs)(b,{children:["Transfer ",e.withSeed?"with seed":""]})}),(0,r.jsxs)(n,{children:[(0,r.jsx)(i,{children:"Amount"}),(0,r.jsxs)(o,{children:[J({amount:e.value,decimals:e.token.decimals})," ",e.token.symbol]})]}),!!e.toAccount&&(0,r.jsxs)(n,{children:[(0,r.jsx)(i,{children:"Destination"}),(0,r.jsx)(o,{children:(0,r.jsx)(a,{address:e.toAccount,url:t})})]})]},x):e.type==="spl-transfer"?(0,r.jsxs)(w,{children:[(0,r.jsx)(n,{children:(0,r.jsxs)(b,{children:["Transfer ",e.token.symbol]})}),(0,r.jsxs)(n,{children:[(0,r.jsx)(i,{children:"Amount"}),(0,r.jsx)(o,{children:e.value.toString()})]}),!!e.fromAta&&(0,r.jsxs)(n,{children:[(0,r.jsx)(i,{children:"Source"}),(0,r.jsx)(o,{children:(0,r.jsx)(a,{address:e.fromAta,url:t})})]}),!!e.toAta&&(0,r.jsxs)(n,{children:[(0,r.jsx)(i,{children:"Destination"}),(0,r.jsx)(o,{children:(0,r.jsx)(a,{address:e.toAta,url:t})})]}),!!e.token.address&&(0,r.jsxs)(n,{children:[(0,r.jsx)(i,{children:"Token"}),(0,r.jsx)(o,{children:(0,r.jsx)(a,{address:e.token.address,url:t})})]})]},x):e.type==="ata-creation"?(0,r.jsxs)(w,{children:[(0,r.jsx)(n,{children:(0,r.jsx)(b,{children:"Create token account"})}),(0,r.jsxs)(n,{children:[(0,r.jsx)(i,{children:"Program ID"}),(0,r.jsx)(o,{children:(0,r.jsx)(a,{address:e.program,url:t})})]}),!!e.owner&&(0,r.jsxs)(n,{children:[(0,r.jsx)(i,{children:"Owner"}),(0,r.jsx)(o,{children:(0,r.jsx)(a,{address:e.owner,url:t})})]})]},x):e.type==="create-account"?(0,r.jsxs)(w,{children:[(0,r.jsx)(n,{children:(0,r.jsxs)(b,{children:["Create account ",e.withSeed?"with seed":""]})}),!!e.account&&(0,r.jsxs)(n,{children:[(0,r.jsx)(i,{children:"Account"}),(0,r.jsx)(o,{children:(0,r.jsx)(a,{address:e.account,url:t})})]}),(0,r.jsxs)(n,{children:[(0,r.jsx)(i,{children:"Amount"}),(0,r.jsxs)(o,{children:[J({amount:e.value,decimals:9})," SOL"]})]})]},x):e.type==="spl-init-account"?(0,r.jsxs)(w,{children:[(0,r.jsx)(n,{children:(0,r.jsx)(b,{children:"Initialize token account"})}),!!e.account&&(0,r.jsxs)(n,{children:[(0,r.jsx)(i,{children:"Account"}),(0,r.jsx)(o,{children:(0,r.jsx)(a,{address:e.account,url:t})})]}),!!e.mint&&(0,r.jsxs)(n,{children:[(0,r.jsx)(i,{children:"Mint"}),(0,r.jsx)(o,{children:(0,r.jsx)(a,{address:e.mint,url:t})})]}),!!e.owner&&(0,r.jsxs)(n,{children:[(0,r.jsx)(i,{children:"Owner"}),(0,r.jsx)(o,{children:(0,r.jsx)(a,{address:e.owner,url:t})})]})]},x):e.type==="spl-close-account"?(0,r.jsxs)(w,{children:[(0,r.jsx)(n,{children:(0,r.jsx)(b,{children:"Close token account"})}),!!e.source&&(0,r.jsxs)(n,{children:[(0,r.jsx)(i,{children:"Source"}),(0,r.jsx)(o,{children:(0,r.jsx)(a,{address:e.source,url:t})})]}),!!e.destination&&(0,r.jsxs)(n,{children:[(0,r.jsx)(i,{children:"Destination"}),(0,r.jsx)(o,{children:(0,r.jsx)(a,{address:e.destination,url:t})})]}),!!e.owner&&(0,r.jsxs)(n,{children:[(0,r.jsx)(i,{children:"Owner"}),(0,r.jsx)(o,{children:(0,r.jsx)(a,{address:e.owner,url:t})})]})]},x):e.type==="spl-sync-native"?(0,r.jsxs)(w,{children:[(0,r.jsx)(n,{children:(0,r.jsx)(b,{children:"Sync native"})}),(0,r.jsxs)(n,{children:[(0,r.jsx)(i,{children:"Program ID"}),(0,r.jsx)(o,{children:(0,r.jsx)(a,{address:e.program,url:t})})]})]},x):e.type==="raydium-swap-base-input"?(0,r.jsxs)(w,{children:[(0,r.jsx)(n,{children:(0,r.jsxs)(b,{children:["Raydium swap"," ",e.tokenIn&&e.tokenOut?`${e.tokenIn.symbol} \u2192 ${e.tokenOut.symbol}`:""]})}),(0,r.jsxs)(n,{children:[(0,r.jsx)(i,{children:"Amount in"}),(0,r.jsx)(o,{children:e.amountIn.toString()})]}),(0,r.jsxs)(n,{children:[(0,r.jsx)(i,{children:"Minimum amount out"}),(0,r.jsx)(o,{children:e.minimumAmountOut.toString()})]}),e.mintIn&&(0,r.jsxs)(n,{children:[(0,r.jsx)(i,{children:"Token in"}),(0,r.jsx)(o,{children:(0,r.jsx)(a,{address:e.mintIn,url:t})})]}),e.mintOut&&(0,r.jsxs)(n,{children:[(0,r.jsx)(i,{children:"Token out"}),(0,r.jsx)(o,{children:(0,r.jsx)(a,{address:e.mintOut,url:t})})]})]},x):e.type==="raydium-swap-base-output"?(0,r.jsxs)(w,{children:[(0,r.jsx)(n,{children:(0,r.jsxs)(b,{children:["Raydium swap"," ",e.tokenIn&&e.tokenOut?`${e.tokenIn.symbol} \u2192 ${e.tokenOut.symbol}`:""]})}),(0,r.jsxs)(n,{children:[(0,r.jsx)(i,{children:"Max amount in"}),(0,r.jsx)(o,{children:e.maxAmountIn.toString()})]}),(0,r.jsxs)(n,{children:[(0,r.jsx)(i,{children:"Amount out"}),(0,r.jsx)(o,{children:e.amountOut.toString()})]}),e.mintIn&&(0,r.jsxs)(n,{children:[(0,r.jsx)(i,{children:"Token in"}),(0,r.jsx)(o,{children:(0,r.jsx)(a,{address:e.mintIn,url:t})})]}),e.mintOut&&(0,r.jsxs)(n,{children:[(0,r.jsx)(i,{children:"Token out"}),(0,r.jsx)(o,{children:(0,r.jsx)(a,{address:e.mintOut,url:t})})]})]},x):e.type==="jupiter-swap-shared-accounts-route"?(0,r.jsxs)(w,{children:[(0,r.jsx)(n,{children:(0,r.jsxs)(b,{children:["Jupiter swap"," ",e.tokenIn&&e.tokenOut?`${e.tokenIn.symbol} \u2192 ${e.tokenOut.symbol}`:""]})}),(0,r.jsxs)(n,{children:[(0,r.jsx)(i,{children:"In amount"}),(0,r.jsx)(o,{children:e.inAmount.toString()})]}),(0,r.jsxs)(n,{children:[(0,r.jsx)(i,{children:"Quoted out amount"}),(0,r.jsx)(o,{children:e.quotedOutAmount.toString()})]}),e.mintIn&&(0,r.jsxs)(n,{children:[(0,r.jsx)(i,{children:"Token in"}),(0,r.jsx)(o,{children:(0,r.jsx)(a,{address:e.mintIn,url:t})})]}),e.mintOut&&(0,r.jsxs)(n,{children:[(0,r.jsx)(i,{children:"Token out"}),(0,r.jsx)(o,{children:(0,r.jsx)(a,{address:e.mintOut,url:t})})]})]},x):e.type==="jupiter-swap-exact-out-route"?(0,r.jsxs)(w,{children:[(0,r.jsx)(n,{children:(0,r.jsxs)(b,{children:["Jupiter swap"," ",e.tokenIn&&e.tokenOut?`${e.tokenIn.symbol} \u2192 ${e.tokenOut.symbol}`:""]})}),(0,r.jsxs)(n,{children:[(0,r.jsx)(i,{children:"Quoted in amount"}),(0,r.jsx)(o,{children:e.quotedInAmount.toString()})]}),(0,r.jsxs)(n,{children:[(0,r.jsx)(i,{children:"Amount out"}),(0,r.jsx)(o,{children:e.outAmount.toString()})]}),e.mintIn&&(0,r.jsxs)(n,{children:[(0,r.jsx)(i,{children:"Token in"}),(0,r.jsx)(o,{children:(0,r.jsx)(a,{address:e.mintIn,url:t})})]}),e.mintOut&&(0,r.jsxs)(n,{children:[(0,r.jsx)(i,{children:"Token out"}),(0,r.jsx)(o,{children:(0,r.jsx)(a,{address:e.mintOut,url:t})})]})]},x):(0,r.jsxs)(w,{children:[(0,r.jsxs)(n,{children:[(0,r.jsx)(i,{children:"Program ID"}),(0,r.jsx)(o,{children:(0,r.jsx)(a,{address:e.program,url:t})})]}),(0,r.jsxs)(n,{children:[(0,r.jsx)(i,{children:"Data"}),(0,r.jsx)(o,{children:e.discriminator})]})]},x))}),(0,r.jsx)(Y,{}),y?(0,r.jsx)(D,{style:{marginTop:"2rem"},children:y.message}):I?(0,r.jsx)(D,{style:{marginTop:"2rem"},children:Nr}):null,(0,r.jsx)(Er,{$useSmallMargins:!(!I&&!y),title:"",address:A,balance:v,errMsg:f||I||y||!p?void 0:"Add funds on Solana to complete transaction."}),(0,r.jsx)(z,{style:{marginTop:"1rem"},loading:C,disabled:k||f,onClick:L,children:u}),(0,r.jsx)(_,{})]})},Er=d(kr)`
  ${s=>s.$useSmallMargins?"margin-top: 0.5rem;":"margin-top: 2rem;"}
`,w=d(S)`
  margin-top: 0.5rem;
  border: 1px solid var(--privy-color-foreground-4);
  border-radius: var(--privy-border-radius-sm);
  padding: 0.5rem;
`,Nr="There was an error preparing your transaction. Your transaction request will likely fail.",Fr=d.div`
  display: flex;
  width: 100%;
  justify-content: center;
  max-height: 40px;

  > img {
    object-fit: contain;
    border-radius: var(--privy-border-radius-sm);
  }
`,Dr=d.span`
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
`,Sr=d.span`
  font-size: 14px;
  font-weight: 500;
  color: var(--privy-color-foreground);
`,Ar=s=>s?.code===sr.COMPLIANCE_BLOCKED,ie=()=>(0,r.jsxs)(ae,{children:[(0,r.jsx)(de,{}),(0,r.jsx)(se,{})]}),Re=({transactionError:s,chainId:c,onClose:l,onRetry:u,chainType:T,transactionHash:g})=>{let{chains:t}=dr(),[p,y]=(0,W.useState)(!1),{errorCode:I,errorMessage:$}=((m,v)=>{if(v==="ethereum")return Ar(m)?{errorCode:"Transaction blocked",errorMessage:m.message}:{errorCode:m.details??m.message,errorMessage:m.shortMessage};let k=m.txSignature,C=m?.transactionMessage||"Something went wrong.";if(Array.isArray(m.logs)){let f=m.logs.find(E=>/insufficient (lamports|funds)/gi.test(E));f&&(C=f)}return{transactionHash:k,errorMessage:C}})(s,T),O=Ar(s),A=(({chains:m,chainId:v,chainType:k,transactionHash:C})=>k==="ethereum"?m.find(f=>f.id===v)?.blockExplorers?.default.url??"https://etherscan.io":function(f,E){return`https://explorer.solana.com/tx/${f}?chain=${E}`}(C||"",v))({chains:t,chainId:c,chainType:T,transactionHash:g});return(0,r.jsxs)(r.Fragment,{children:[(0,r.jsx)(U,{onClose:l}),(0,r.jsxs)(oe,{children:[(0,r.jsx)(ie,{}),(0,r.jsx)(te,{children:I}),(0,r.jsx)(le,{children:O?"This transaction cannot be completed.":"Please try again."}),(0,r.jsxs)(Mr,{children:[(0,r.jsx)(Cr,{children:"Error message"}),(0,r.jsx)($r,{$clickable:!1,children:$})]}),g&&(0,r.jsxs)(Mr,{children:[(0,r.jsx)(Cr,{children:"Transaction hash"}),(0,r.jsxs)(he,{children:["Copy this hash to view details about the transaction on a"," ",(0,r.jsx)("u",{children:(0,r.jsx)("a",{href:A,children:"block explorer"})}),"."]}),(0,r.jsxs)($r,{$clickable:!0,onClick:async()=>{await navigator.clipboard.writeText(g),y(!0)},children:[g,(0,r.jsx)(ue,{clicked:p})]})]}),!O&&(0,r.jsx)(ce,{onClick:()=>u({resetNonce:!!g}),children:"Retry transaction"})]}),(0,r.jsx)(hr,{})]})},oe=d.div`
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
`,te=d.span`
  color: var(--privy-color-foreground);
  text-align: center;
  font-size: 1.125rem;
  font-weight: 500;
  line-height: 1.25rem; /* 111.111% */
  text-align: center;
  margin: 10px;
`,le=d.span`
  margin-top: 4px;
  margin-bottom: 10px;
  color: var(--privy-color-foreground-3);
  text-align: center;

  font-size: 0.875rem;
  font-style: normal;
  font-weight: 400;
  line-height: 20px; /* 142.857% */
  letter-spacing: -0.008px;
`,ae=d.div`
  position: relative;
  width: 60px;
  height: 60px;
  margin: 10px;
  display: flex;
  justify-content: center;
  align-items: center;
`,se=d(gr)`
  position: absolute;
  width: 35px;
  height: 35px;
  color: var(--privy-color-error);
`,de=d.div`
  position: absolute;
  width: 60px;
  height: 60px;
  border-radius: 50%;
  background-color: var(--privy-color-error);
  opacity: 0.1;
`,ce=d(z)`
  && {
    margin-top: 24px;
  }
  transition:
    color 350ms ease,
    background-color 350ms ease;
`,Cr=d.span`
  width: 100%;
  text-align: left;
  font-size: 0.825rem;
  color: var(--privy-color-foreground);
  padding: 4px;
`,Mr=d.div`
  width: 100%;
  margin: 5px;
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;
`,he=d.text`
  position: relative;
  width: 100%;
  padding: 5px;
  font-size: 0.8rem;
  color: var(--privy-color-foreground-3);
  text-align: left;
  word-wrap: break-word;
`,$r=d.span`
  position: relative;
  width: 100%;
  background-color: var(--privy-color-background-2);
  padding: 8px 12px;
  border-radius: 10px;
  margin-top: 5px;
  font-size: 14px;
  color: var(--privy-color-foreground-3);
  text-align: left;
  word-wrap: break-word;
  ${s=>s.$clickable&&`cursor: pointer;
  transition: background-color 0.3s;
  padding-right: 45px;

  &:hover {
    background-color: var(--privy-color-foreground-4);
  }`}
`,me=d(ur)`
  position: absolute;
  top: 13px;
  right: 13px;
  width: 24px;
  height: 24px;
`,pe=d(pr)`
  position: absolute;
  top: 13px;
  right: 13px;
  width: 24px;
  height: 24px;
`,ue=({clicked:s})=>(0,r.jsx)(s?pe:me,{});export{Ue as a,We as b,Re as c};
