import{a as Fe,b as Te}from"./chunk-EIKQ77TI.js";import{a as Ee}from"./chunk-K3ZBYGD3.js";import{a as ne,b as oe,c as ie,d as ae,e as se,f as le,g as ce,h as de,i as ue,l as me}from"./chunk-O7HS2NIV.js";import{B as ee,C as re,E as te,y as Z}from"./chunk-WKEWYTK5.js";import{a as _,b as Ce,c as M,d as B,e as V,f as ve,g as z,h as W,i as we,j as A,k as O,l as q,m as I,n as R,o as x,p as F,q as Q}from"./chunk-BYSGHTGU.js";import{d as $}from"./chunk-DDMB76UL.js";import{a as E}from"./chunk-6PFHC3TA.js";import"./chunk-6KIN4EGD.js";import{D as P,I as D,J as ye,e as U,f as pe,h as he,v as fe,w as ge}from"./chunk-I3B2SZVL.js";import"./chunk-LSJ7DHXG.js";import{g as be}from"./chunk-LAOCC7HV.js";import"./chunk-RX72V2DT.js";import{b as L,c as g,d as v}from"./chunk-ISE4SGOS.js";import"./chunk-IKQFIZGK.js";import{b as G}from"./chunk-FGSKM2Q7.js";import{M as K,Wa as p,e as T,jb as J,ka as xe}from"./chunk-DHATLY5R.js";import"./chunk-QCZJZLKO.js";import{I as H,a as X,ua as S}from"./chunk-BMCS4PVW.js";import"./chunk-2HUGHRMV.js";import{a as Ie,b as Re}from"./chunk-AKQZC4JI.js";import"./chunk-VGKAVQRI.js";import"./chunk-JG6YPVA3.js";import"./chunk-TMJMA6BR.js";import"./chunk-JTYV7RXW.js";import{e as N}from"./chunk-KL2DZ7E2.js";var e=N(Re(),1),m=N(Ie(),1);var Wr=N(xe(),1);var qr=N(Fe(),1);var j=class extends m.Component{static getDerivedStateFromError(){return{hasError:!0}}componentDidCatch(t,o){this.props.onError(t)}componentDidUpdate(t){t.resetKey!==this.props.resetKey&&this.state.hasError&&this.setState({hasError:!1})}render(){return this.state.hasError?null:this.props.children}constructor(...t){super(...t),this.state={hasError:!1}}};function Le(r,t,o){let n=Number(r);return!Number.isFinite(n)||n===0?`1 ${t} \u2248 ${r} ${o}`:n>=.01?`1 ${t} \u2248 ${_e(n)} ${o}`:`${_e(1/n)} ${t} \u2248 1 ${o}`}function _e(r){return r>=1e3?new Intl.NumberFormat("en-US",{maximumFractionDigits:0}).format(Math.round(r)):r>=100?new Intl.NumberFormat("en-US",{maximumFractionDigits:1}).format(r):r>=1?new Intl.NumberFormat("en-US",{maximumFractionDigits:2}).format(r):new Intl.NumberFormat("en-US",{maximumFractionDigits:4}).format(r)}function ke(r,t){let o=Number(r);if(!Number.isFinite(o)||o===0)return r;let n=t!=null?o/10**t:o;return n>=1e3?new Intl.NumberFormat("en-US",{maximumFractionDigits:2}).format(n):n>=1?new Intl.NumberFormat("en-US",{maximumFractionDigits:4}).format(n):n>=1e-4?new Intl.NumberFormat("en-US",{maximumFractionDigits:6}).format(n):new Intl.NumberFormat("en-US",{maximumSignificantDigits:4}).format(n)}function Y({address:r,caip2:t,config:o}){for(let n of o.currencies){let a=n.chains.find((l=>l.caip2===t&&l.address.toLowerCase()===r.toLowerCase()));if(a)return{symbol:n.symbol.toUpperCase(),decimals:a.decimals}}return{symbol:r,decimals:void 0}}function Ne(r,t){return t[r]?.displayName??r}function Se(r,t){if(!r.chains[t.destinationChain])return`Unsupported destination chain: "${t.destinationChain}". Check that the chain is in CAIP-2 format (e.g. "eip155:8453") and is supported for deposit addresses.`;let o=t.destinationCurrency.toLowerCase();return r.currencies.some((n=>n.chains.some((a=>a.caip2===t.destinationChain&&a.address.toLowerCase()===o))))?null:`Unsupported destination currency "${t.destinationCurrency}" on chain "${t.destinationChain}". Check that this token address is supported on the specified chain.`}var Pe=new Set(["ROUTE_UNAVAILABLE","UNEXPECTED_STATE","TIMEOUT_WAITING_FOR_NEXT_ORDER","TIMEOUT_ORDER_COMPLETION","DEPOSIT_FAILED","DEPOSIT_REFUNDED","USER_EXITED","AMOUNT_TOO_LOW","INSUFFICIENT_LIQUIDITY","UNSUPPORTED_CHAIN","UNSUPPORTED_CURRENCY","UNSUPPORTED_ROUTE","NO_SWAP_ROUTES_FOUND","NO_INTERNAL_SWAP_ROUTES_FOUND","NO_QUOTES","SANCTIONED_WALLET_ADDRESS","REFUND_WALLET_CREATION_FAILED","DEPOSIT_ADDRESSES_NOT_ENABLED","NOT_AUTHENTICATED"]);function $e(r){return Pe.has(r)}function Ue(r){return $e(r)?r:"UNKNOWN_ERROR"}function De(){let{params:r,setModalState:t}=g(),{privy:o}=T(),n=(function(){let{privy:c,refreshSessionAndUser:d}=T();return(0,m.useCallback)(((i,s)=>s?Promise.resolve({ok:!0,address:s}):S.resolveRefundAddress({privy:c,caip2:i,onWalletCreated:d})),[c,d])})(),[a,l]=(0,m.useState)(!1);return{fetchQuote:(0,m.useCallback)((async(c,d,i)=>{if(r){l(!0);try{let s=await n(c.caip2,r.refundAddress);if(!s.ok)return void t({step:"error",code:Ue(s.error)});let u=await o.fetchPrivyRoute(X,{body:{source_chain:c.caip2,source_currency:c.currencyAddress,destination_chain:r.destinationChain,destination_currency:r.destinationCurrency,destination_address:r.destinationAddress,refund_address:s.address,...r.slippageBps!=null?{slippage_bps:r.slippageBps}:{}}});t({step:"address",selectedCurrency:d,selectedChain:c,availableChains:i,quote:u})}catch(s){let u=s instanceof Error?s:Error(String(s)),h="status"in u&&typeof u.status=="number"?u.status:void 0;t({step:"error",code:u instanceof H&&u.code==="feature_not_enabled"?"DEPOSIT_ADDRESSES_NOT_ENABLED":h&&h>=500?"UNKNOWN_ERROR":Ue(u.message),message:u.message})}finally{l(!1)}}}),[r,o,n,t]),isFetching:a}}function Ae(r,t){switch(r.status){case"completed":return t({step:"complete",order:r});case"refunded":return t({step:"refunded",order:r});case"failed":return t({step:"failed",order:r});case"executing":return t({step:"processing",order:r});default:return}}var Me=({sourceAmount:r,sourceSymbol:t,sourceChainName:o,sourceDecimals:n,destinationAmount:a,destSymbol:l,destChainName:c,destDecimals:d,onClose:i})=>(0,e.jsx)(_,{icon:U,iconVariant:"success",title:"Transfer complete",subtitle:a?`Received ${ke(r,n)} ${t} on ${o} and converted it to ${ke(a,d)} ${l} on ${c}. Funds are available to use.`:`Your ${t} has been received and is now available in your wallet.`,showClose:!0,onClose:i,primaryCta:{label:"Done",onClick:i},watermark:!1});function Be(){let{state:r,configData:t,close:o}=v("complete"),{order:n}=r,{sourceSymbol:a,sourceChainName:l,sourceDecimals:c,destSymbol:d,destChainName:i,destDecimals:s}=(0,m.useMemo)((()=>{let u=Y({address:n.source_currency,caip2:n.source_chain,config:t}),h=Y({address:n.destination_currency,caip2:n.destination_chain,config:t});return{sourceSymbol:u.symbol,sourceChainName:Ne(n.source_chain,t.chains),sourceDecimals:u.decimals,destSymbol:h.symbol,destChainName:Ne(n.destination_chain,t.chains),destDecimals:h.decimals}}),[n,t]);return(0,e.jsx)(Me,{sourceAmount:n.source_amount,sourceSymbol:a,sourceChainName:l,sourceDecimals:c,destinationAmount:n.destination_amount,destSymbol:d,destChainName:i,destDecimals:s,onClose:o})}function Ve(){let{modalState:r,setModalState:t,config:o,retryConfig:n,close:a}=g();if(r.step!=="error")throw Error("UNEXPECTED_STATE");let{code:l}=r,{title:c,subtitle:d,detail:i,iconVariant:s}=(y=>{switch(y){case"AMOUNT_TOO_LOW":return{title:"Amount too low",subtitle:"The deposit amount is below the minimum for this route.",detail:"Try a larger amount or a different token.",iconVariant:"warning"};case"INSUFFICIENT_LIQUIDITY":return{title:"Insufficient liquidity",subtitle:"There isn't enough liquidity for this route right now.",detail:"Try a smaller amount or a different network.",iconVariant:"warning"};case"UNSUPPORTED_CHAIN":return{title:"Unsupported chain",subtitle:"Deposits from this chain type aren't supported yet. Try a different network.",iconVariant:"warning"};case"UNSUPPORTED_CURRENCY":case"UNSUPPORTED_ROUTE":case"ROUTE_UNAVAILABLE":case"NO_SWAP_ROUTES_FOUND":case"NO_INTERNAL_SWAP_ROUTES_FOUND":case"NO_QUOTES":return{title:"Route not available",subtitle:"This deposit route isn't supported right now. Try a different token or network.",iconVariant:"warning"};case"SANCTIONED_WALLET_ADDRESS":return{title:"Address restricted",subtitle:"This address cannot be used for deposits due to compliance restrictions.",iconVariant:"warning"};case"REFUND_WALLET_CREATION_FAILED":return{title:"Unable to set up refund address",subtitle:"We couldn't create a wallet to receive refunds on this chain. Please try again or select a different network.",iconVariant:"warning"};case"DEPOSIT_ADDRESSES_NOT_ENABLED":return{title:"Not enabled",subtitle:"Deposit addresses are not enabled for this app.",iconVariant:"warning"};case"NOT_AUTHENTICATED":return{title:"Not signed in",subtitle:"Please sign in to continue with your deposit.",iconVariant:"warning"};case"TIMEOUT_WAITING_FOR_NEXT_ORDER":case"TIMEOUT_ORDER_COMPLETION":return{title:"Taking longer than expected",subtitle:"Your funds are safe. The deposit is still being processed \u2014 check back later.",iconVariant:"subtle"};default:return{title:"Something went wrong",subtitle:"We couldn't complete your request. Please try again.",iconVariant:"subtle"}}})(l),[u,h]=(0,m.useState)(!1);return(0,e.jsx)(_,{icon:D,iconVariant:s,title:c,subtitle:i?`${d} ${i}`:d,showClose:!0,onClose:a,primaryCta:{label:"Try again",onClick:async()=>{if(o.status!=="ready"){h(!0);try{await n(),t({step:"token"})}catch{h(!1)}}else t({step:"token"})},loading:u},watermark:!0})}function ze(){let{state:r,close:t}=v("failed"),{order:o}=r;return(0,e.jsx)(E,{icon:D,iconVariant:"error",title:"Transfer failed",subtitle:"Something went wrong processing your transfer.",showClose:!0,onClose:t,primaryCta:{label:"Done",onClick:t},secondaryCta:{label:"Learn about manual recovery",onClick:()=>window.open("https://docs.privy.io","_blank","noopener,noreferrer")},watermark:!0,children:(0,e.jsxs)(We,{href:o.tracking_url,target:"_blank",rel:"noopener noreferrer",children:["Reference: ",o.provider_request_id]})})}var We=p.a`
  text-align: center;
  font-size: 0.75rem;
  opacity: 0.7;
  text-decoration: underline;
  cursor: pointer;
  color: var(--privy-color-foreground-3);
`;function qe(){let{close:r,setModalState:t,config:o,params:n,onBack:a}=g(),[l,c]=(0,m.useState)(!1);return(0,m.useEffect)((()=>{if(l&&n){if(o.status==="ready"){let d=Se(o.data,n);t(d?{step:"error",code:"ROUTE_UNAVAILABLE",message:d}:{step:"token"})}o.status==="error"&&t({step:"error",code:"ROUTE_UNAVAILABLE"})}}),[l,o,n,t]),(0,e.jsx)(_,{icon:P,iconVariant:"subtle",title:"Add funds",subtitle:"Top up your account by sending crypto from any wallet. Conversion and routing handled by Relay.",showClose:!0,onClose:r,showBack:!!a,onBack:a,primaryCta:{label:"Continue",onClick:()=>{if(o.status==="ready"&&n){let d=Se(o.data,n);t(d?{step:"error",code:"ROUTE_UNAVAILABLE",message:d}:{step:"token"})}else o.status==="error"?t({step:"error",code:"ROUTE_UNAVAILABLE"}):c(!0)},loading:l&&o.status==="loading",loadingText:null},watermark:!0})}function Qe(){let{state:r,setModalState:t,close:o}=v("network"),[n,a]=(0,m.useState)(-1),{availableChains:l}=r,{confirm:c,isFetching:d}=(function(){let i=L(),{params:s}=g(),{fetchQuote:u,isFetching:h}=De();return{confirm:(0,m.useCallback)((async y=>{if(!y||!s)return;let f=i?.modalState;f&&f.step==="network"&&await u(y,f.selectedCurrency,f.availableChains)}),[s,i,u]),isFetching:h}})();return(0,e.jsx)(E,{title:"Select network",eyebrow:(0,e.jsxs)("span",{style:{display:"flex",alignItems:"center",gap:"0.375rem"},children:[(0,e.jsx)("img",{src:r.selectedCurrency.logoURI,alt:"",style:{width:"1rem",height:"1rem",borderRadius:"50%"}}),"Send ",r.selectedCurrency.symbol]}),showBack:!0,onBack:()=>t({step:"token"}),showClose:!0,onClose:o,watermark:!0,children:(0,e.jsx)($,{style:{marginTop:"1rem",height:"22rem"},$colorScheme:"light",children:l.map(((i,s)=>(0,e.jsxs)(z,{$selected:n===s,disabled:d,onClick:()=>{a(s),c(i)},children:[(0,e.jsx)(B,{src:i.iconUrl,alt:i.displayName}),(0,e.jsx)(V,{children:i.displayName}),d&&s===n&&(0,e.jsx)(Q,{})]},i.caip2)))})})}var je=({trackingUrl:r,onClose:t})=>(0,e.jsx)(E,{icon:fe,iconVariant:"subtle",title:"Transfer in progress",subtitle:"Your deposit was received and the transfer is now processing.",showClose:!0,onClose:t,secondaryCta:{label:"View on block explorer \u2197",onClick:()=>window.open(r,"_blank","noopener,noreferrer")},watermark:!1,children:(0,e.jsxs)(we,{children:[(0,e.jsxs)(A,{children:[(0,e.jsx)(O,{$status:"done",children:(0,e.jsx)(U,{size:14,color:"var(--privy-color-icon-success)",strokeWidth:2})}),(0,e.jsx)(I,{children:"Deposit received"})]}),(0,e.jsx)(q,{}),(0,e.jsxs)(A,{children:[(0,e.jsx)(O,{$status:"active",children:(0,e.jsx)(Ye,{})}),(0,e.jsx)(I,{children:"Bridging"})]}),(0,e.jsx)(q,{}),(0,e.jsxs)(A,{children:[(0,e.jsx)(O,{$status:"pending"}),(0,e.jsx)(I,{children:"Funds arrived"})]})]})}),Ye=p.span`
  width: 0.75rem;
  height: 0.75rem;
  border: 2px solid var(--privy-color-foreground-3);
  border-bottom-color: transparent;
  border-radius: 50%;
  display: inline-block;
  animation: spin 1s linear infinite;

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
`;function Xe(){let{state:r,close:t}=v("processing");return(function({orderId:o,enabled:n}){let{privy:a}=T(),{setModalState:l}=g();(0,m.useEffect)((()=>{let c=new AbortController;return S.waitForCompletion({privy:a,orderId:o,signal:c.signal}).then((d=>{c.signal.aborted||(d.status==="success"?Ae(d.order,l):d.status==="timeout"&&l({step:"error",code:"TIMEOUT_ORDER_COMPLETION"}))})),()=>{c.abort()}}),[n,o,a,l])})({orderId:r.order.id,enabled:!0}),(0,e.jsx)(je,{trackingUrl:r.order.tracking_url,onClose:t})}function He(){let{state:r,close:t}=v("refunded"),{order:o}=r;return(0,e.jsx)(_,{icon:ye,iconVariant:"subtle",title:"Transfer refunded",subtitle:"Your transfer was received, but the swap couldn't be completed. A refund has been started automatically.",showClose:!0,onClose:t,primaryCta:{label:"Done",onClick:t},secondaryCta:{label:"View transaction details",onClick:()=>window.open(o.tracking_url,"_blank","noopener,noreferrer")},watermark:!0})}function Ke(){let{close:r,setModalState:t,config:o}=g(),{confirm:n,currencies:a,isFetching:l}=(function(){let{config:i,setModalState:s}=g(),{fetchQuote:u,isFetching:h}=De(),y=i.status==="ready"?i.data.currencies:[];return{confirm:(0,m.useCallback)((async f=>{if(i.status!=="ready"||!f)return;let b=(function(C,Oe){return C.chains.map((w=>{let k=Oe.chains[w.caip2];return k?{caip2:w.caip2,displayName:k.displayName,iconUrl:k.iconUrl,vmType:k.vmType,currencyAddress:w.address,currencyDecimals:w.decimals}:null})).filter((w=>w!==null))})(f,i.data);if(b.length!==1)s({step:"network",selectedCurrency:f,availableChains:b});else{let C=b[0];await u(C,f,b)}}),[i,u,s]),currencies:y,isFetching:h}})(),[c,d]=(0,m.useState)(-1);return(0,e.jsx)(E,{title:"Select token",showBack:!0,onBack:()=>t({step:"intro"}),showClose:!0,onClose:r,watermark:!0,children:o.status==="error"?(0,e.jsx)(W,{children:(0,e.jsx)(Ce,{children:"Failed to load tokens"})}):o.status==="loading"?(0,e.jsx)(W,{children:(0,e.jsx)(J,{})}):(0,e.jsx)($,{style:{marginTop:"1rem",height:"22rem"},$colorScheme:"light",children:a.map(((i,s)=>(0,e.jsxs)(z,{$selected:c===s,disabled:l,onClick:()=>{d(s),n(i)},children:[(0,e.jsx)(M,{src:i.logoURI,alt:i.symbol}),(0,e.jsx)(V,{children:i.name}),l&&s===c?(0,e.jsx)(Q,{}):(0,e.jsx)(ve,{children:i.symbol})]},i.symbol)))})})}function Ge({address:r,onClick:t}){let[o,n]=(0,m.useState)(!1);return(0,e.jsx)(e.Fragment,{children:o?(0,e.jsx)(Je,{onClick:()=>n(!1),style:{marginTop:"1.5rem"},children:(0,e.jsx)(Te,{url:r,size:312,hideLogo:!0})}):(0,e.jsxs)(Ze,{title:"Click to copy address",onClick:t,style:{marginTop:"1.5rem"},children:[(0,e.jsxs)(er,{children:[(0,e.jsx)(rr,{children:"Deposit address"}),(0,e.jsx)(tr,{children:r})]}),(0,e.jsx)(nr,{children:(0,e.jsx)(or,{type:"button",onClick:a=>{a.stopPropagation(),n(!0)},children:(0,e.jsx)(P,{size:16,color:"var(--privy-color-icon-muted)"})})})]})})}var Je=p.div`
  display: flex;
  justify-content: center;
  align-items: center;
  cursor: pointer;
  overflow: hidden;
`,Ze=p.div`
  display: flex;
  border-radius: var(--privy-border-radius-md);
  background: var(--privy-color-background-clicked, #f1f2f9);
  padding: 1rem;
  cursor: pointer;
  gap: 0.5rem;
`,er=p.div`
  flex: 1;
  min-width: 0;
  text-align: left;
`,rr=p.div`
  font-size: 0.75rem;
  color: var(--privy-color-icon-muted);
  line-height: 1rem;
  margin-bottom: 0.25rem;
`,tr=p.div`
  word-break: break-all;
  font-size: 0.875rem;
  font-family: ui-monospace, monospace;
  font-weight: 500;
  line-height: 1.375rem;
  color: var(--privy-color-foreground);
`,nr=p.div`
  width: 1.5rem;
  flex-shrink: 0;
  display: flex;
  justify-content: center;
  padding-top: 0.25rem;
`,or=p.button`
  && {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 1.5rem;
    height: 1.5rem;
    border: none;
    background: transparent;
    cursor: pointer;
    outline: none;
    box-shadow: none;
    border-radius: var(--privy-border-radius-xs);

    &:hover {
      background: var(--privy-color-background);
    }

    &:focus,
    &:focus-visible {
      outline: none;
      box-shadow: none;
    }
  }
`;function ir({quote:r,selectedCurrency:t,selectedChain:o,destinationSymbol:n}){let[a,l]=(0,m.useState)(!1),c=t.symbol.toUpperCase(),d=o.displayName,i=(0,m.useRef)(null);return(0,e.jsxs)(ar,{children:[(0,e.jsxs)(sr,{onClick:(0,m.useCallback)((()=>{let s=document.getElementById("privy-modal-content");s&&(i.current&&clearTimeout(i.current),s.style.transition="none",i.current=setTimeout((()=>{s.style.transition="",i.current=null}),160)),l((u=>!u))}),[]),children:[(0,e.jsxs)(lr,{children:[t.logoURI&&(0,e.jsx)(M,{src:t.logoURI,alt:c,style:{width:"2rem",height:"2rem"}}),o.iconUrl&&(0,e.jsx)(cr,{src:o.iconUrl,alt:d})]}),(0,e.jsxs)(dr,{children:[(0,e.jsx)(ur,{children:"You send"}),(0,e.jsxs)(mr,{children:[c," on ",d]})]}),(0,e.jsx)(pr,{children:(0,e.jsx)(a?he:pe,{size:16})})]}),(0,e.jsx)(yr,{$expanded:a,children:(0,e.jsx)(br,{children:(0,e.jsxs)(hr,{children:[r.indicative_rate&&(0,e.jsxs)(R,{children:[(0,e.jsx)(x,{children:"Conversion rate"}),(0,e.jsxs)(F,{style:{display:"flex",alignItems:"center",gap:"0.25rem"},children:[Le(r.indicative_rate,c,n.toUpperCase()),(0,e.jsx)(Cr,{content:"Estimated rate based on current market conditions. Final execution price may vary depending on transfer size and routing."})]})]}),(0,e.jsxs)(R,{children:[(0,e.jsx)(x,{children:"Max slippage"}),(0,e.jsxs)(F,{children:[(r.slippage_bps/100).toFixed(1),"%"]})]}),(0,e.jsxs)(R,{children:[(0,e.jsx)(x,{children:"Refund address"}),(0,e.jsx)(F,{children:(0,e.jsx)(Ee,{value:r.refund_address,iconOnly:!0,iconSize:11,children:K(r.refund_address,4,4)})})]})]})})}),(0,e.jsxs)(fr,{children:[(0,e.jsx)(D,{size:16,color:"var(--privy-color-icon-muted)",style:{flexShrink:0}}),(0,e.jsxs)(gr,{children:["Only send ",(0,e.jsx)("strong",{children:c})," on ",(0,e.jsx)("strong",{children:d}),". Other assets may be lost."]})]})]})}var ar=p.div`
  border-radius: var(--privy-border-radius-md);
  border: 1px solid var(--privy-color-foreground-4);
  overflow: hidden;
`,sr=p.button`
  && {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.75rem 1rem;
    background: transparent;
    border: none;
    cursor: pointer;
    color: var(--privy-color-foreground);
    outline: none;
    box-shadow: none;

    &:focus,
    &:focus-visible {
      outline: none;
      box-shadow: none;
    }
  }
`,lr=p.span`
  position: relative;
  width: 2rem;
  height: 2rem;
  flex-shrink: 0;
`,cr=p(B)`
  && {
    position: absolute;
    top: -0.125rem;
    right: -0.25rem;
    width: 0.75rem;
    height: 0.75rem;
    box-sizing: content-box;
    border: 1.5px solid #fff;
    background-color: #fff;
  }
`,dr=p.div`
  display: flex;
  flex-direction: column;
  align-items: flex-start;
`,ur=p.span`
  font-size: 0.75rem;
  color: var(--privy-color-foreground-3);
  line-height: 1rem;
`,mr=p.span`
  font-size: 0.875rem;
  font-weight: 500;
  line-height: 1.25rem;
`,pr=p.span`
  margin-left: auto;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 1.5rem;
  height: 1.5rem;
  border-radius: var(--privy-border-radius-full);
  background-color: var(--privy-color-background-clicked, #f1f2f9);
  color: var(--privy-color-foreground-3);
`,hr=p.div`
  display: flex;
  flex-direction: column;
  padding: 0 1rem 0.75rem;

  & > * {
    padding: 0.5rem 0;
    border-bottom: 1px solid var(--privy-color-foreground-4);
  }

  & > *:last-child {
    border-bottom: none;
  }
`,fr=p.div`
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin: 0 0.75rem 0.75rem;
  padding: 0.625rem 0.75rem;
  border-radius: var(--privy-border-radius-sm);
  background: #f8f9fc;
`,gr=p.span`
  font-size: 0.8125rem;
  line-height: 1.25rem;
  color: var(--privy-color-icon-muted);
  text-align: left;
`,yr=p.div`
  display: grid;
  grid-template-rows: ${({$expanded:r})=>r?"1fr":"0fr"};
  transition: grid-template-rows 150ms ease-out;
`,br=p.div`
  overflow: hidden;
`;function Cr({content:r}){let[t,o]=(0,m.useState)(!1),{refs:n,floatingStyles:a,context:l}=se({open:t,onOpenChange:o,placement:"top",whileElementsMounted:Z,middleware:[ee(6),te(),re({padding:8})]}),c=ne(l,{move:!1,handleClose:me()}),d=le(l),{getReferenceProps:i,getFloatingProps:s}=ce([c,d,ie(l),ae(l),de(l,{role:"tooltip"})]),{isMounted:u,styles:h}=ue(l,{duration:150});return(0,e.jsxs)(e.Fragment,{children:[(0,e.jsx)("button",{ref:n.setReference,type:"button","aria-label":"More information about conversion rate",style:{display:"inline-flex",alignItems:"center",justifyContent:"center",padding:0,border:"none",background:"none",color:"var(--privy-color-icon-muted)",cursor:"pointer"},...i(),children:(0,e.jsx)(ge,{size:14})}),u&&(0,e.jsx)(oe,{root:document.getElementById("privy-modal-content")??void 0,children:(0,e.jsx)(vr,{ref:n.setFloating,style:{...a,...h},...s(),children:r})})]})}var vr=p.div`
  max-width: 13rem;
  padding: 0.5rem 0.625rem;
  border-radius: var(--privy-border-radius-sm, 0.375rem);
  background: var(--privy-color-foreground);
  color: var(--privy-color-background);
  font-size: 0.6875rem;
  line-height: 1rem;
  font-weight: 400;
  text-align: left;
  z-index: 10;
`,wr=({quote:r,selectedCurrency:t,selectedChain:o,destinationSymbol:n,onBack:a,onClose:l})=>{let[c,d]=(0,m.useState)(!1),i=t?.symbol?.toUpperCase()??"funds",s=o?.displayName??"",u=async()=>{c||(await navigator.clipboard.writeText(r.deposit_address),d(!0),setTimeout((()=>d(!1)),2e3))};return(0,e.jsxs)(E,{title:`Send ${i}${s?` on ${s}`:""}`,subtitle:"Send funds to the address below. Conversion and routing handled by Relay.",showBack:!0,onBack:a,showClose:!0,onClose:l,watermark:!1,children:[(0,e.jsx)(ir,{quote:r,selectedCurrency:t,selectedChain:o,destinationSymbol:n}),(0,e.jsx)(Ge,{address:r.deposit_address,onClick:u}),(0,e.jsx)(be,{style:{marginTop:"1rem",marginBottom:"0.5rem",...c?{backgroundColor:"var(--privy-color-icon-success)",borderColor:"var(--privy-color-icon-success)"}:{}},onClick:u,children:c?(0,e.jsxs)(e.Fragment,{children:["Copied ",(0,e.jsx)(U,{size:16,style:{marginLeft:"0.25rem"}})]}):"Copy address"}),(0,e.jsx)(Er,{children:"Routing and bridging are handled by Relay. Privy does not control execution timing, liquidity, or transaction outcomes."})]})},Er=p.p`
  && {
    margin: 0.5rem 0 0;
    font-size: 0.6875rem;
    line-height: 1.125rem;
    color: var(--privy-color-icon-muted);
    text-align: center;
  }
`;function Tr(){let{state:r,configData:t,setModalState:o,close:n,params:a}=v("address"),{quote:l,selectedCurrency:c,selectedChain:d,availableChains:i}=r;return(function({depositAddressId:s,enabled:u,quoteCreatedAt:h}){let{privy:y}=T(),{setModalState:f}=g();(0,m.useEffect)((()=>{if(!s)return;let b=new AbortController;return S.waitForDeposit({privy:y,depositAddressId:s,quoteCreatedAt:h,signal:b.signal}).then((C=>{b.signal.aborted||(C.status==="success"?Ae(C.order,f):C.status==="timeout"&&f({step:"error",code:"TIMEOUT_WAITING_FOR_NEXT_ORDER"}))})),()=>{b.abort()}}),[u,s,y,h,f])})({depositAddressId:l.id,enabled:!0,quoteCreatedAt:l.created_at}),(0,e.jsx)(wr,{quote:l,selectedCurrency:c,selectedChain:d,destinationSymbol:(0,m.useMemo)((()=>Y({address:a.destinationCurrency,caip2:a.destinationChain,config:t}).symbol),[a,t]),onBack:()=>o({step:"network",selectedCurrency:c,availableChains:i}),onClose:n})}function _r(){let{modalState:r,setModalState:t}=g();return(0,e.jsx)(j,{onError:o=>t({step:"error",code:"UNEXPECTED_STATE",message:o.message}),resetKey:r.step,children:(0,e.jsx)(kr,{})})}function kr(){let{modalState:r}=g();switch(r.step){case"intro":return(0,e.jsx)(qe,{});case"token":return(0,e.jsx)(Ke,{});case"network":return(0,e.jsx)(Qe,{});case"address":return(0,e.jsx)(Tr,{});case"processing":return(0,e.jsx)(Xe,{});case"complete":return(0,e.jsx)(Be,{});case"refunded":return(0,e.jsx)(He,{});case"failed":return(0,e.jsx)(ze,{});case"error":return(0,e.jsx)(Ve,{});default:return null}}var jr={component:()=>{let{onUserCloseViaDialogOrKeybindRef:r}=G(),t=L(),{close:o,config:n}=g();return(0,m.useEffect)((()=>{r.current=o}),[r,o]),(0,m.useEffect)((()=>{if(n.status==="ready"){for(let a of n.data.currencies)new Image().src=a.logoURI;for(let a of Object.values(n.data.chains))new Image().src=a.iconUrl}}),[n]),t?(0,e.jsx)(_r,{}):null}};export{jr as default};
