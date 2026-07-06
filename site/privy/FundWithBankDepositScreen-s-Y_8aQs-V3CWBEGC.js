import{a as z}from"./chunk-D6JNGGXX.js";import{a as I,b as F,c as P}from"./chunk-UQ2SWAGR.js";import"./chunk-DP3POPDW.js";import{b as D}from"./chunk-K3ZBYGD3.js";import{a as f}from"./chunk-6PFHC3TA.js";import"./chunk-6KIN4EGD.js";import{K as B,e as L,m as U,v as W}from"./chunk-I3B2SZVL.js";import"./chunk-LSJ7DHXG.js";import"./chunk-LAOCC7HV.js";import{ya as V}from"./chunk-BA2HXBNG.js";import"./chunk-M6F3L6JA.js";import"./chunk-ISE4SGOS.js";import"./chunk-QAOMSF4E.js";import"./chunk-L35YQFWA.js";import"./chunk-IKQFIZGK.js";import"./chunk-IJDSLHK6.js";import{f as _}from"./chunk-5GDNIVMJ.js";import"./chunk-7GRE4WMZ.js";import"./chunk-V6FGMHEW.js";import"./chunk-5IEIH52H.js";import"./chunk-IV5FR2YO.js";import{b as j}from"./chunk-FGSKM2Q7.js";import{Wa as w,ka as J,r as T}from"./chunk-DHATLY5R.js";import"./chunk-QCZJZLKO.js";import{ta as S}from"./chunk-BMCS4PVW.js";import"./chunk-2HUGHRMV.js";import{a as X,b as G}from"./chunk-AKQZC4JI.js";import"./chunk-3XBTBSJO.js";import"./chunk-VGKAVQRI.js";import"./chunk-JG6YPVA3.js";import"./chunk-TMJMA6BR.js";import"./chunk-JTYV7RXW.js";import{e as x}from"./chunk-KL2DZ7E2.js";var e=x(G(),1),d=x(X(),1);var Y=x(J(),1);var Q=t=>{try{return t.location.origin}catch{return}},Z=({data:t,onClose:a})=>(0,e.jsx)(f,{showClose:!0,onClose:a,title:"Initiate bank transfer",subtitle:"Use the details below to complete a bank transfer from your bank.",primaryCta:{label:"Done",onClick:a},watermark:!1,footerText:"Exchange rates and fees are set when you authorize and determine the amount you receive. You'll see the applicable rates and fees for your transaction separately",children:(0,e.jsx)(tt,{children:(V[t.deposit_instructions.asset]||[]).map((([u,y],g)=>{let m=t.deposit_instructions[u];if(!m||Array.isArray(m))return null;let o=u==="asset"?m.toUpperCase():m,h=o.length>100?`${o.slice(0,9)}...${o.slice(-9)}`:o;return(0,e.jsxs)(et,{children:[(0,e.jsx)(rt,{children:y}),(0,e.jsx)(D,{value:o,includeChildren:Y.isMobile,children:(0,e.jsx)(ot,{children:h})})]},g)}))})}),tt=w.ol`
  border-color: var(--privy-color-border-default);
  border-width: 1px;
  border-radius: var(--privy-border-radius-mdlg);
  border-style: solid;
  display: flex;
  flex-direction: column;

  && {
    padding: 0 1rem;
  }
`,et=w.li`
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 1rem 0;

  &:not(:first-of-type) {
    border-top: 1px solid var(--privy-color-border-default);
  }

  & > {
    :nth-child(1) {
      flex-basis: 30%;
    }

    :nth-child(2) {
      flex-basis: 60%;
    }
  }
`,rt=w.span`
  color: var(--privy-color-foreground);
  font-kerning: none;
  font-variant-numeric: lining-nums proportional-nums;
  font-feature-settings: 'calt' off;

  /* text-xs/font-regular */
  font-size: 0.75rem;
  font-style: normal;
  font-weight: 400;
  line-height: 1.125rem; /* 150% */

  text-align: left;
  flex-shrink: 0;
`,ot=w.span`
  color: var(--privy-color-foreground);
  font-kerning: none;
  font-feature-settings: 'calt' off;

  /* text-sm/font-medium */
  font-size: 0.875rem;
  font-style: normal;
  font-weight: 500;
  line-height: 1.375rem; /* 157.143% */

  text-align: right;
  word-break: break-all;
`,st=({onClose:t})=>(0,e.jsx)(f,{showClose:!0,onClose:t,icon:U,iconVariant:"error",title:"Something went wrong",subtitle:"We couldn't complete account setup. This isn't caused by anything you did.",primaryCta:{label:"Close",onClick:t},watermark:!0}),it=({onClose:t,reason:a})=>{let u=a?a.charAt(0).toLowerCase()+a.slice(1):void 0;return(0,e.jsx)(f,{showClose:!0,onClose:t,icon:U,iconVariant:"error",title:"Identity verification failed",subtitle:u?`We can't complete identity verification because ${u}. Please try again or contact support for assistance.`:"We couldn't verify your identity. Please try again or contact support for assistance.",primaryCta:{label:"Close",onClick:t},watermark:!0})},at=({onClose:t,email:a})=>(0,e.jsx)(f,{showClose:!0,onClose:t,icon:W,title:"Identity verification in progress",subtitle:"We're waiting for Persona to approve your identity verification. This usually takes a few minutes, but may take up to 24 hours.",primaryCta:{label:"Done",onClick:t},watermark:!0,children:(0,e.jsxs)(z,{theme:"light",children:["You'll receive an email at ",a," once approved with instructions for completing your deposit."]})}),nt=({onClose:t,onAcceptTerms:a,isLoading:u})=>(0,e.jsx)(f,{showClose:!0,onClose:t,icon:B,title:"Verify your identity to continue",subtitle:"Finish verification with Persona \u2014 it takes just a few minutes and requires a government ID.",helpText:(0,e.jsxs)(e.Fragment,{children:[`This app uses Bridge to securely connect accounts and move funds. By clicking "Accept," you agree to Bridge's`," ",(0,e.jsx)("a",{href:"https://www.bridge.xyz/legal",target:"_blank",rel:"noopener noreferrer",children:"Terms of Service"})," ","and"," ",(0,e.jsx)("a",{href:"https://www.bridge.xyz/legal/row-privacy-policy/bridge-building-limited",target:"_blank",rel:"noopener noreferrer",children:"Privacy Policy"}),"."]}),primaryCta:{label:"Accept and continue",onClick:a,loading:u},watermark:!0}),lt=({onClose:t})=>(0,e.jsx)(f,{showClose:!0,onClose:t,icon:L,iconVariant:"success",title:"Identity verified successfully",subtitle:"We've successfully verified your identity. Now initiate a bank transfer to view instructions.",primaryCta:{label:"Initiate bank transfer",onClick:()=>{},loading:!0},watermark:!0}),ct=({opts:t,onClose:a,onEditSourceAsset:u,onSelectAmount:y,isLoading:g})=>(0,e.jsxs)(f,{showClose:!0,onClose:a,headerTitle:`Buy ${t.destination.asset.toLocaleUpperCase()}`,primaryCta:{label:"Continue",onClick:y,loading:g},watermark:!0,children:[(0,e.jsx)(I,{currency:t.source.selectedAsset,inputMode:"decimal",autoFocus:!0}),(0,e.jsx)(F,{selectedAsset:t.source.selectedAsset,onEditSourceAsset:u})]}),ut=({onClose:t,onAcceptTerms:a,onSelectAmount:u,onSelectSource:y,onEditSourceAsset:g,opts:m,state:o,email:h,isLoading:n})=>o.status==="select-amount"?(0,e.jsx)(ct,{onClose:t,onSelectAmount:u,onEditSourceAsset:g,opts:m,isLoading:n}):o.status==="select-source-asset"?(0,e.jsx)(P,{onSelectSource:y,opts:m,isLoading:n}):o.status==="kyc-prompt"?(0,e.jsx)(nt,{onClose:t,onAcceptTerms:a,opts:m,isLoading:n}):o.status==="kyc-incomplete"?(0,e.jsx)(at,{onClose:t,email:h}):o.status==="kyc-success"?(0,e.jsx)(lt,{onClose:t}):o.status==="kyc-error"?(0,e.jsx)(it,{onClose:t,reason:o.reason}):o.status==="account-details"?(0,e.jsx)(Z,{onClose:t,data:o.data}):o.status==="create-customer-error"||o.status==="get-customer-error"?(0,e.jsx)(st,{onClose:t}):null,Ut={component:()=>{let{user:t}=T(),a=j().data;if(!a?.FundWithBankDepositScreen)throw Error("Missing data");let{onSuccess:u,onFailure:y,opts:g,createOrUpdateCustomer:m,getCustomer:o,getOrCreateVirtualAccount:h}=a.FundWithBankDepositScreen,[n,E]=(0,d.useState)(g),[k,r]=(0,d.useState)({status:"select-amount"}),[b,c]=(0,d.useState)(null),[$,i]=(0,d.useState)(!1),v=(0,d.useRef)(null),M=(0,d.useCallback)((async()=>{let s;i(!0),c(null);try{s=await o({kycRedirectUrl:window.location.origin})}catch(l){if(!l||typeof l!="object"||!("status"in l)||l.status!==404)return r({status:"get-customer-error"}),c(l),void i(!1)}if(!s)try{s=await m({hasAcceptedTerms:!1,kycRedirectUrl:window.location.origin})}catch(l){return r({status:"create-customer-error"}),c(l),void i(!1)}if(!s)return r({status:"create-customer-error"}),c(Error("Unable to create customer")),void i(!1);if(s.status==="not_started"&&s.kyc_url)return r({status:"kyc-prompt",kycUrl:s.kyc_url}),void i(!1);if(s.status==="not_started")return r({status:"get-customer-error"}),c(Error("Unexpected user state")),void i(!1);if(s.status==="rejected")return r({status:"kyc-error",reason:s.rejection_reasons?.[0]?.reason}),c(Error("User KYC rejected.")),void i(!1);if(s.status==="incomplete")return r({status:"kyc-incomplete"}),void i(!1);if(s.status!=="active")return r({status:"get-customer-error"}),c(Error("Unexpected user state")),void i(!1);s.status;try{let l=await h({destination:n.destination,provider:n.provider,source:{asset:n.source.selectedAsset}});r({status:"account-details",data:l})}catch(l){return r({status:"create-customer-error"}),c(l),void i(!1)}}),[n]),R=(0,d.useCallback)((async()=>{if(c(null),i(!0),k.status!=="kyc-prompt")return c(Error("Unexpected state")),void i(!1);let s=_({location:k.kycUrl});if(await m({hasAcceptedTerms:!0}),!s)return c(Error("Unable to begin kyc flow.")),i(!1),void r({status:"create-customer-error"});v.current=new AbortController;let l=await(async(p,q)=>{let A=await S({operation:async()=>({done:Q(p)===window.location.origin,closed:p.closed}),until:({done:H,closed:N})=>H||N,delay:0,interval:500,attempts:360,signal:q});return A.status==="aborted"?(p.close(),{status:"aborted"}):A.status==="max_attempts"?{status:"timeout"}:A.result.done?(p.close(),{status:"redirected"}):{status:"closed"}})(s,v.current.signal);if(l.status==="aborted")return;if(l.status==="closed")return void i(!1);l.status;let C=await S({operation:()=>o({}),until:p=>p.status==="active"||p.status==="rejected",delay:0,interval:2e3,attempts:60,signal:v.current.signal});if(C.status!=="aborted"){if(C.status==="max_attempts")return r({status:"kyc-incomplete"}),void i(!1);if(C.status,C.result.status==="rejected")return r({status:"kyc-error",reason:C.result.rejection_reasons?.[0]?.reason}),c(Error("User KYC rejected.")),void i(!1);if(C.result.status!=="active")return r({status:"kyc-incomplete"}),void i(!1);s.closed||s.close(),C.result.status;try{r({status:"kyc-success"});let p=await h({destination:n.destination,provider:n.provider,source:{asset:n.source.selectedAsset}});r({status:"account-details",data:p})}catch(p){r({status:"create-customer-error"}),c(p)}finally{i(!1)}}}),[r,c,i,m,h,k,n,v]),K=(0,d.useCallback)((s=>{r({status:"select-amount"}),E({...n,source:{...n.source,selectedAsset:s}})}),[r,E]),O=(0,d.useCallback)((()=>{r({status:"select-source-asset"})}),[r]);return(0,e.jsx)(ut,{onClose:(0,d.useCallback)((async()=>{v.current?.abort(),b?y(b):await u()}),[b,v]),opts:n,state:k,isLoading:$,email:t.email.address,onAcceptTerms:R,onSelectAmount:M,onSelectSource:K,onEditSourceAsset:O})}};export{Ut as FundWithBankDepositScreen,Ut as default};
