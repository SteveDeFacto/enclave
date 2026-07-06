import{a as T,b as g}from"./chunk-RLV65INC.js";import{a as k}from"./chunk-6PFHC3TA.js";import{H as S,j as z,t as C}from"./chunk-I3B2SZVL.js";import{n as L}from"./chunk-5GDNIVMJ.js";import{b as A}from"./chunk-FGSKM2Q7.js";import{B as u,Va as b,Wa as o,e as I,ka as D,lb as N,r as P,u as w}from"./chunk-DHATLY5R.js";import{a as j,b as B}from"./chunk-AKQZC4JI.js";import{e as x}from"./chunk-KL2DZ7E2.js";var e=x(B(),1);var l=x(j(),1);var pe=x(D(),1);var M=({passkeys:s,name:c,isLoading:m,errorReason:h,success:d,expanded:n,onLinkPasskey:y,onUnlinkPasskey:i,onExpand:r,onBack:t,onClose:a})=>d?(0,e.jsx)(k,{title:"Passkeys updated",icon:z,iconVariant:"success",primaryCta:{label:"Done",onClick:a},onClose:a,watermark:!0}):n?(0,e.jsx)(k,{icon:C,title:"Your passkeys",onBack:t,onClose:a,watermark:!0,children:(0,e.jsx)(U,{passkeys:s,expanded:n,onUnlink:i,onExpand:r})}):(0,e.jsxs)(k,{icon:C,title:"Set up passkey verification",subtitle:"Verify with passkey",primaryCta:{label:"Add new passkey",onClick:y,loading:m},onClose:a,watermark:!0,helpText:h||void 0,children:[s.length===0?(0,e.jsx)(F,{}):(0,e.jsx)(_,{children:(0,e.jsx)(U,{passkeys:s,expanded:n,onUnlink:i,onExpand:r})}),c?(0,e.jsxs)(O,{children:[(0,e.jsx)(V,{children:"New Passkey Name"}),(0,e.jsx)($,{children:c})]}):null]}),_=o.div`
  margin-bottom: 0.75rem;
`,O=o.div`
  margin-top: 0.25rem;
`,V=o.div`
  color: var(--privy-color-foreground-2);
  font-size: 0.75rem;
  font-weight: 500;
  line-height: 1rem;
  margin-bottom: 0.25rem;
`,$=o.div`
  color: var(--privy-color-foreground);
  font-size: 0.875rem;
  line-height: 1.25rem;
`,U=({passkeys:s,expanded:c,onUnlink:m,onExpand:h})=>{let[d,n]=(0,l.useState)([]),y=c?s.length:2;return(0,e.jsxs)("div",{children:[(0,e.jsx)(q,{children:"Your passkeys"}),(0,e.jsxs)(K,{children:[s.slice(0,y).map((i=>{return(0,e.jsxs)(J,{children:[(0,e.jsxs)("div",{children:[(0,e.jsx)(G,{children:(r=i,r.authenticatorName?r.createdWithBrowser?`${r.authenticatorName} on ${r.createdWithBrowser}`:r.authenticatorName:r.createdWithBrowser?r.createdWithOs?`${r.createdWithBrowser} on ${r.createdWithOs}`:`${r.createdWithBrowser}`:"Unknown device")}),(0,e.jsxs)(H,{children:["Last used:"," ",(i.latestVerifiedAt??i.firstVerifiedAt)?.toLocaleString()??"N/A"]})]}),(0,e.jsx)(X,{disabled:d.includes(i.credentialId),onClick:()=>(async t=>{n((a=>a.concat([t]))),await m(t),n((a=>a.filter((f=>f!==t))))})(i.credentialId),children:d.includes(i.credentialId)?(0,e.jsx)(N,{}):(0,e.jsx)(S,{size:16})})]},i.credentialId);var r})),s.length>2&&!c&&(0,e.jsx)(Y,{onClick:h,children:"View all"})]})]})},F=()=>(0,e.jsxs)(T,{style:{color:"var(--privy-color-foreground)"},children:[(0,e.jsx)(g,{children:"Verify with Touch ID, Face ID, PIN, or hardware key"}),(0,e.jsx)(g,{children:"Takes seconds to set up and use"}),(0,e.jsx)(g,{children:"Use your passkey to verify transactions and login to your account"})]}),me={component:()=>{let{user:s}=P(),{unlink:c}=L(),{linkWithPasskey:m,closePrivyModal:h}=I(),{data:d}=A(),n=s?.linkedAccounts.filter((p=>p.type==="passkey")),[y,i]=(0,l.useState)(!1),[r,t]=(0,l.useState)(""),[a,f]=(0,l.useState)(!1),[W,v]=(0,l.useState)(!1);return(0,l.useEffect)((()=>{n.length===0&&v(!1)}),[n.length]),(0,e.jsx)(M,{passkeys:n,name:d?.passkeyAuthModalData?.name,isLoading:y,errorReason:r,success:a,expanded:W,onLinkPasskey:()=>{i(!0),m({name:d?.passkeyAuthModalData?.name}).then((()=>f(!0))).catch((p=>{if(p instanceof w){if(p.privyErrorCode===u.CANNOT_LINK_MORE_OF_TYPE)return void t("Cannot link more passkeys to account.");if(p.privyErrorCode===u.PASSKEY_NOT_ALLOWED)return void t("Passkey request timed out or rejected by user.")}t("Unknown error occurred.")})).finally((()=>{i(!1)}))},onUnlinkPasskey:async p=>(i(!0),await c({credentialId:p}).then((()=>f(!0))).catch((E=>{E instanceof w&&E.privyErrorCode===u.MISSING_MFA_CREDENTIALS?t("Cannot unlink a passkey enrolled in MFA"):t("Unknown error occurred.")})).finally((()=>{i(!1)}))),onExpand:()=>v(!0),onBack:()=>v(!1),onClose:()=>h()})}},he=o.div`
  display: flex;
  align-items: center;
  justify-content: center;
  width: 180px;
  height: 90px;
  border-radius: 50%;
  svg + svg {
    margin-left: 12px;
  }
  > svg {
    z-index: 2;
    color: var(--privy-color-accent) !important;
    stroke: var(--privy-color-accent) !important;
    fill: var(--privy-color-accent) !important;
  }
`,R=b`
  && {
    width: 100%;
    font-size: 0.875rem;
    line-height: 1rem;

    /* Tablet and Up */
    @media (min-width: 440px) {
      font-size: 14px;
    }

    display: flex;
    gap: 12px;
    justify-content: center;

    padding: 6px 8px;
    background-color: var(--privy-color-background);
    transition: background-color 200ms ease;
    color: var(--privy-color-accent) !important;

    :focus {
      outline: none;
      box-shadow: none;
    }
  }
`,Y=o.button`
  ${R}
`,K=o.div`
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 0.8rem;
  padding: 0.5rem 0rem 0rem;
  flex-grow: 1;
  width: 100%;
`,q=o.div`
  line-height: 20px;
  height: 20px;
  font-size: 1em;
  font-weight: 450;
  display: flex;
  justify-content: flex-beginning;
  width: 100%;
`,G=o.div`
  font-size: 1em;
  line-height: 1.3em;
  font-weight: 500;
  color: var(--privy-color-foreground-2);
  padding: 0.2em 0;
`,H=o.div`
  font-size: 0.875rem;
  line-height: 1rem;
  color: #64668b;
  padding: 0.2em 0;
`,J=o.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 1em;
  gap: 10px;
  font-size: 0.875rem;
  line-height: 1rem;
  text-align: left;
  border-radius: 8px;
  border: 1px solid #e2e3f0 !important;
  width: 100%;
  height: 5em;
`,Q=b`
  :focus,
  :hover,
  :active {
    outline: none;
  }
  display: flex;
  width: 2em;
  height: 2em;
  justify-content: center;
  align-items: center;
  svg {
    color: var(--privy-color-error);
  }
  svg:hover {
    color: var(--privy-color-foreground-3);
  }
`,X=o.button`
  ${Q}
`;export{M as a,me as b,he as c,Y as d};
