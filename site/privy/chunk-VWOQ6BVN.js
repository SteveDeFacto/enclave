import{a as M}from"./chunk-UKDWEP2C.js";import{a as z}from"./chunk-J3WINMEE.js";import{a as $}from"./chunk-3QTPWOWY.js";import{a as S}from"./chunk-FZRLKM4J.js";import{a as W}from"./chunk-M7K5POIM.js";import{a as y}from"./chunk-TF4QA2ZZ.js";import{a as g}from"./chunk-X5QQB7Z2.js";import"./chunk-AIJD6O2L.js";import{d as f,g as h,i as A,m}from"./chunk-3TPGN3TC.js";import{b as C}from"./chunk-FVYEL4IS.js";import{Wa as i,e as w,ka as P}from"./chunk-UGSP3DD6.js";import"./chunk-QCZJZLKO.js";import{ab as k}from"./chunk-OV7GNHZT.js";import"./chunk-AD5BZVLA.js";import{a as B,b as N}from"./chunk-RYBZHIKX.js";import"./chunk-JVFQFJH5.js";import"./chunk-VHIR2IYC.js";import"./chunk-LYIDHH4Z.js";import"./chunk-JTYV7RXW.js";import{e as u}from"./chunk-3IKZH76S.js";var r=u(N(),1);var p=u(B(),1);var lr=u(P(),1);var F=i.span`
  && {
    width: 82px;
    height: 82px;
    border-width: 4px;
    border-style: solid;
    border-color: ${e=>e.color??"var(--privy-color-accent)"};
    border-bottom-color: transparent;
    border-radius: 50%;
    display: inline-block;
    box-sizing: border-box;
    animation: rotation 1.2s linear infinite;
    transition: border-color 800ms;
    border-bottom-color: ${e=>e.color??"var(--privy-color-accent)"};
  }
`;function U(e){return(0,r.jsxs)("svg",{xmlns:"http://www.w3.org/2000/svg",width:"24",height:"24",viewBox:"0 0 24 24",fill:"none",stroke:"currentColor","stroke-width":"2","stroke-linecap":"round","stroke-linejoin":"round",...e,children:[(0,r.jsx)("circle",{cx:"12",cy:"12",r:"10"}),(0,r.jsx)("line",{x1:"12",x2:"12",y1:"8",y2:"12"}),(0,r.jsx)("line",{x1:"12",x2:"12.01",y1:"16",y2:"16"})]})}var j=({onTransfer:e,isTransferring:n,transferSuccess:o})=>(0,r.jsx)(h,{...o?{success:!0,children:"Success!"}:{warn:!0,loading:n,onClick:e,children:"Transfer and delete account"}}),E=i.div`
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  width: 100%;
  padding-bottom: 16px;
`,x=i.div`
  display: flex;
  flex-direction: column;
  && p {
    font-size: 14px;
  }
  width: 100%;
  gap: 16px;
`,L=i.div`
  display: flex;
  cursor: pointer;
  align-items: center;
  width: 100%;
  border: 1px solid var(--privy-color-foreground-4) !important;
  border-radius: var(--privy-border-radius-md);
  padding: 8px 10px;
  font-size: 14px;
  font-weight: 500;
  gap: 8px;
`,_=i(S)`
  position: relative;
  width: ${({$iconSize:e})=>`${e}px`};
  height: ${({$iconSize:e})=>`${e}px`};
  color: var(--privy-color-foreground-3);
  margin-left: auto;
`,V=i($)`
  position: relative;
  width: 15px;
  height: 15px;
  color: var(--privy-color-foreground-3);
  margin-left: auto;
`,q=i.ol`
  display: flex;
  flex-direction: column;
  font-size: 14px;
  width: 100%;
  text-align: left;
`,I=i.li`
  font-size: 14px;
  list-style-type: auto;
  list-style-position: outside;
  margin-left: 1rem;
  margin-bottom: 0.5rem; /* Adjust the margin as needed */

  &:last-child {
    margin-bottom: 0; /* Remove margin from the last item */
  }
`,G=i.div`
  position: relative;
  width: 60px;
  height: 60px;
  margin: 10px;
  display: flex;
  justify-content: center;
  align-items: center;
`,H=()=>(0,r.jsx)(G,{children:(0,r.jsx)(_,{$iconSize:60})}),J=({address:e,onClose:n,onRetry:o,onTransfer:c,isTransferring:l,transferSuccess:d})=>{let{defaultChain:t}=k(),a=t.blockExplorers?.default.url??"https://etherscan.io";return(0,r.jsxs)(r.Fragment,{children:[(0,r.jsx)(m,{onClose:n,backFn:o}),(0,r.jsxs)(E,{children:[(0,r.jsx)(H,{}),(0,r.jsxs)(x,{children:[(0,r.jsx)("h3",{children:"Check account assets before transferring"}),(0,r.jsx)("p",{children:"Before transferring, ensure there are no assets in the other account. Assets in that account will not transfer automatically and may be lost."}),(0,r.jsxs)(q,{children:[(0,r.jsx)("p",{children:" To check your balance, you can:"}),(0,r.jsx)(I,{children:"Log out and log back into the other account, or "}),(0,r.jsxs)(I,{children:["Copy your wallet address and use a"," ",(0,r.jsx)("u",{children:(0,r.jsx)("a",{target:"_blank",href:a,children:"block explorer"})})," ","to see if the account holds any assets."]})]}),(0,r.jsxs)(L,{onClick:()=>navigator.clipboard.writeText(e).catch(console.error),children:[(0,r.jsx)(g,{color:"var(--privy-color-foreground-1)",strokeWidth:2,height:"28px",width:"28px"}),(0,r.jsx)(y,{address:e,showCopyIcon:!1}),(0,r.jsx)(V,{})]}),(0,r.jsx)(j,{onTransfer:c,isTransferring:l,transferSuccess:d})]})]}),(0,r.jsx)(f,{})]})},pr={component:()=>{let{initiateAccountTransfer:e,closePrivyModal:n}=w(),{data:o,navigate:c,lastScreen:l,setModalData:d}=C(),[t,a]=(0,p.useState)(void 0),[s,D]=(0,p.useState)(!1),[v,b]=(0,p.useState)(!1),T=async()=>{try{if(!o?.accountTransfer?.nonce||!o?.accountTransfer?.account)throw Error("missing account transfer inputs");b(!0),await e({nonce:o?.accountTransfer?.nonce,account:o?.accountTransfer?.account,accountType:o?.accountTransfer?.linkMethod,externalWalletMetadata:o?.accountTransfer?.externalWalletMetadata,telegramWebAppData:o?.accountTransfer?.telegramWebAppData,telegramAuthResult:o?.accountTransfer?.telegramAuthResult,farcasterEmbeddedAddress:o?.accountTransfer?.farcasterEmbeddedAddress,oAuthUserInfo:o?.accountTransfer?.oAuthUserInfo}),D(!0),b(!1),setTimeout(n,1e3)}catch(R){d({errorModalData:{error:R,previousScreen:l||"LinkConflictScreen"}}),c("ErrorScreen",!0)}};return t?(0,r.jsx)(J,{address:t,onClose:n,onRetry:()=>a(void 0),onTransfer:T,isTransferring:v,transferSuccess:s}):(0,r.jsx)(K,{onClose:n,onInfo:()=>a(o?.accountTransfer?.embeddedWalletAddress),onContinue:()=>a(o?.accountTransfer?.embeddedWalletAddress),onTransfer:T,isTransferring:v,transferSuccess:s,data:o})}},K=({onClose:e,onContinue:n,onInfo:o,onTransfer:c,transferSuccess:l,isTransferring:d,data:t})=>{if(!t?.accountTransfer?.linkMethod||!t?.accountTransfer?.displayName)return;let a={method:t?.accountTransfer?.linkMethod,handle:t?.accountTransfer?.displayName,disclosedAccount:t?.accountTransfer?.embeddedWalletAddress?{type:"wallet",handle:t?.accountTransfer?.embeddedWalletAddress}:void 0};return(0,r.jsxs)(r.Fragment,{children:[(0,r.jsx)(m,{closeable:!0}),(0,r.jsxs)(E,{children:[(0,r.jsx)(M,{children:(0,r.jsxs)("div",{children:[(0,r.jsx)(F,{color:"var(--privy-color-error)"}),(0,r.jsx)(W,{height:38,width:38,stroke:"var(--privy-color-error)"})]})}),(0,r.jsxs)(x,{children:[(0,r.jsxs)("h3",{children:[function(s){switch(s){case"sms":return"Phone number";case"email":return"Email address";case"siwe":return"Wallet address";case"siws":return"Solana wallet address";case"linkedin":return"LinkedIn profile";case"google":case"apple":case"discord":case"github":case"instagram":case"spotify":case"tiktok":case"line":case"twitch":case"twitter":case"telegram":case"farcaster":return`${z(s.replace("_oauth",""))} profile`;default:return s.startsWith("privy:")?"Cross-app account":s}}(a.method)," is associated with another account"]}),(0,r.jsxs)("p",{children:["Do you want to transfer",(0,r.jsx)("b",{children:a.handle?` ${a.handle}`:""})," to this account instead? This will delete your other account."]}),(0,r.jsx)(O,{onClick:o,disclosedAccount:a.disclosedAccount})]}),(0,r.jsxs)(x,{style:{gap:12,marginTop:12},children:[t?.accountTransfer?.embeddedWalletAddress?(0,r.jsx)(h,{onClick:n,children:"Continue"}):(0,r.jsx)(j,{onTransfer:c,transferSuccess:l,isTransferring:d}),(0,r.jsx)(A,{onClick:e,children:"No thanks"})]})]}),(0,r.jsx)(f,{})]})};function O({disclosedAccount:e,onClick:n}){return e?(0,r.jsxs)(L,{onClick:n,children:[(0,r.jsx)(g,{color:"var(--privy-color-foreground-1)",strokeWidth:2,height:"28px",width:"28px"}),(0,r.jsx)(y,{address:e.handle,showCopyIcon:!1}),(0,r.jsx)(U,{width:15,height:15,color:"var(--privy-color-foreground-3)",style:{marginLeft:"auto"}})]}):null}export{pr as LinkConflictScreen,K as LinkConflictScreenView,pr as default};
