import{d as R,f as U,k as W,m as E,n as H}from"./chunk-7546Y75W.js";import{a as T}from"./chunk-P3QRRVDY.js";import"./chunk-MSKKCL2R.js";import{h as _}from"./chunk-STCN3NYB.js";import{a as o}from"./chunk-7QNQM5YS.js";import"./chunk-QSYOL7C5.js";import{g as I}from"./chunk-3TPGN3TC.js";import{ca as N}from"./chunk-FV2AAPQX.js";import"./chunk-CJPO3VTC.js";import"./chunk-ESV6JEIL.js";import"./chunk-QAOMSF4E.js";import"./chunk-3ZWNU7CV.js";import"./chunk-5VJVPF2Z.js";import"./chunk-BOEOVMBZ.js";import"./chunk-AA7RRP2U.js";import"./chunk-UM4F4LLA.js";import"./chunk-PQCP3NT5.js";import"./chunk-7DSUPGAS.js";import"./chunk-IV5FR2YO.js";import{b as P}from"./chunk-FVYEL4IS.js";import{D as C,Va as S,Wa as n,e as x,ka as G,m as k,r as A}from"./chunk-UGSP3DD6.js";import"./chunk-QCZJZLKO.js";import"./chunk-OV7GNHZT.js";import"./chunk-AD5BZVLA.js";import{a as K,b as Y}from"./chunk-RYBZHIKX.js";import"./chunk-EFK6JAUM.js";import"./chunk-JVFQFJH5.js";import"./chunk-VHIR2IYC.js";import"./chunk-LYIDHH4Z.js";import"./chunk-JTYV7RXW.js";import{e as c}from"./chunk-3IKZH76S.js";var e=c(Y(),1);var i=c(K(),1);var de=c(G(),1);var ue={component:()=>{let[a,h]=(0,i.useState)(!0),{authenticated:u,user:O}=A(),{walletProxy:y,closePrivyModal:v,createAnalyticsEvent:f,client:V}=x(),{navigate:$,data:j,onUserCloseViaDialogOrKeybindRef:F}=P(),[m,z]=(0,i.useState)(void 0),[w,l]=(0,i.useState)(""),[p,g]=(0,i.useState)(!1),{entropyId:d,entropyIdVerifier:M,onCompleteNavigateTo:b,onSuccess:q,onFailure:B}=j.recoverWallet,s=(r="User exited before their wallet could be recovered")=>{v({shouldCallAuthOnSuccess:!1}),B(typeof r=="string"?new C(r):r)};return F.current=s,(0,i.useEffect)(()=>{if(!u)return s("User must be authenticated and have a Privy wallet before it can be recovered")},[u]),(0,e.jsxs)(o,{children:[(0,e.jsx)(o.Header,{icon:T,title:"Enter your password",subtitle:"Please provision your account on this new device. To continue, enter your recovery password.",showClose:!0,onClose:s}),(0,e.jsx)(o.Body,{children:(0,e.jsx)(J,{children:(0,e.jsxs)("div",{children:[(0,e.jsxs)(U,{children:[(0,e.jsx)(R,{type:a?"password":"text",onChange:r=>(t=>{t&&z(t)})(r.target.value),disabled:p,style:{paddingRight:"2.3rem"}}),(0,e.jsx)(W,{style:{right:"0.75rem"},children:a?(0,e.jsx)(E,{onClick:()=>h(!1)}):(0,e.jsx)(H,{onClick:()=>h(!0)})})]}),!!w&&(0,e.jsx)(L,{children:w})]})})}),(0,e.jsxs)(o.Footer,{children:[(0,e.jsx)(o.HelpText,{children:(0,e.jsxs)(_,{children:[(0,e.jsx)("h4",{children:"Why is this necessary?"}),(0,e.jsx)("p",{children:"You previously set a password for this wallet. This helps ensure only you can access it"})]})}),(0,e.jsx)(o.Actions,{children:(0,e.jsx)(Q,{loading:p||!y,disabled:!m,onClick:async()=>{g(!0);let r=await V.getAccessToken(),t=k(O,d);if(!r||!t||m===null)return s("User must be authenticated and have a Privy wallet before it can be recovered");try{f({eventName:"embedded_wallet_recovery_started",payload:{walletAddress:t.address}}),await y?.recover({accessToken:r,entropyId:d,entropyIdVerifier:M,recoveryPassword:m}),l(""),b?$(b):v({shouldCallAuthOnSuccess:!1}),q?.(t),f({eventName:"embedded_wallet_recovery_completed",payload:{walletAddress:t.address}})}catch(D){N(D)?l("Invalid recovery password, please try again."):l("An error has occurred, please try again.")}finally{g(!1)}},$hideAnimations:!d&&p,children:"Recover your account"})}),(0,e.jsx)(o.Watermark,{})]})]})}},J=n.div`
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
`,L=n.div`
  line-height: 20px;
  height: 20px;
  font-size: 13px;
  color: var(--privy-color-error);
  text-align: left;
  margin-top: 0.5rem;
`,Q=n(I)`
  ${({$hideAnimations:a})=>a&&S`
      && {
        // Remove animations because the recoverWallet task on the iframe partially
        // blocks the renderer, so the animation stutters and doesn't look good
        transition: none;
      }
    `}
`;export{ue as PasswordRecoveryScreen,ue as default};
