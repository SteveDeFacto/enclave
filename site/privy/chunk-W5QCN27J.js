import{a as l,e as s,g as c}from"./chunk-MTLR7ZUN.js";import{d as y}from"./chunk-ZYJYWN6R.js";import"./chunk-EPTHIVTU.js";import"./chunk-7QNQM5YS.js";import{D as h,b as p,p as f}from"./chunk-AIJD6O2L.js";import"./chunk-QSYOL7C5.js";import"./chunk-3TPGN3TC.js";import{Ja as C,Ka as b}from"./chunk-FV2AAPQX.js";import"./chunk-CJPO3VTC.js";import"./chunk-ESV6JEIL.js";import"./chunk-QAOMSF4E.js";import"./chunk-3ZWNU7CV.js";import"./chunk-5VJVPF2Z.js";import"./chunk-BOEOVMBZ.js";import"./chunk-AA7RRP2U.js";import"./chunk-UM4F4LLA.js";import"./chunk-PQCP3NT5.js";import"./chunk-7DSUPGAS.js";import"./chunk-IV5FR2YO.js";import{b as u}from"./chunk-FVYEL4IS.js";import{Wa as a,ka as j}from"./chunk-UGSP3DD6.js";import"./chunk-QCZJZLKO.js";import{ab as d}from"./chunk-OV7GNHZT.js";import"./chunk-AD5BZVLA.js";import{a as k,b as S}from"./chunk-RYBZHIKX.js";import"./chunk-EFK6JAUM.js";import"./chunk-JVFQFJH5.js";import"./chunk-VHIR2IYC.js";import"./chunk-LYIDHH4Z.js";import"./chunk-JTYV7RXW.js";import{e as n}from"./chunk-3IKZH76S.js";var r=n(S(),1);var i=n(k(),1);var z=n(j(),1);var E={component:()=>{let t=C(),{onUserCloseViaDialogOrKeybindRef:m}=u(),x=d(),o=(0,i.useRef)(!1);(0,i.useEffect)(()=>{t&&(o.current=!1)},[t]);let e=(0,i.useCallback)(async()=>{!o.current&&t&&(o.current=!0,b(),await t.onCancel())},[t]);return(0,i.useEffect)(()=>(m.current=e,()=>{m.current===e&&(m.current=null)}),[e,m]),t?t.error?(0,r.jsx)(l,{icon:p,iconVariant:"warning",title:"Unable to add funds",subtitle:t.error,showClose:!0,onClose:e,primaryCta:{label:"Close",onClick:e}}):(0,r.jsx)(l,{icon:p,iconVariant:"subtle",title:"Select method",subtitle:"Choose how to fund your wallet",showClose:!0,onClose:e,children:(0,r.jsxs)(y,{style:{marginTop:"1rem"},$colorScheme:x.appearance.palette.colorScheme,children:[t.startFiat&&(0,r.jsxs)(c,{onClick:async()=>{o.current||(o.current=!0,await t.startFiat?.())},children:[(0,r.jsx)(g,{children:(0,r.jsx)(f,{})}),(0,r.jsxs)(w,{children:[(0,r.jsx)(s,{children:"Pay with fiat"}),(0,r.jsx)(v,{children:"Apple Pay, Google Pay, or debit card"})]})]}),t.startCrypto&&(0,r.jsxs)(c,{onClick:async()=>{o.current||(o.current=!0,await t.startCrypto?.())},children:[(0,r.jsx)(g,{children:(0,r.jsx)(h,{})}),(0,r.jsxs)(w,{children:[(0,r.jsx)(s,{children:"Transfer from wallet"}),(0,r.jsx)(v,{children:"Send crypto from any wallet"})]})]})]})}):null}},g=a.span`
  width: 2rem;
  height: 2rem;
  border-radius: var(--privy-border-radius-full);
  background-color: var(--privy-color-background-2);
  color: var(--color-icon-muted, #64668b);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;

  svg {
    width: 1.125rem;
    height: 1.125rem;
  }
`,w=a.span`
  display: flex;
  flex-direction: column;
  align-items: flex-start;
`,v=a.span`
  font-size: 0.875rem;
  line-height: 1.25rem;
  color: var(--privy-color-foreground-3);
`;export{E as AddFundsSelectionScreen,E as default};
