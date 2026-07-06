import{a as l,e as s,g as c}from"./chunk-BYSGHTGU.js";import{d as y}from"./chunk-DDMB76UL.js";import"./chunk-6PFHC3TA.js";import"./chunk-6KIN4EGD.js";import{D as h,b as p,p as f}from"./chunk-I3B2SZVL.js";import"./chunk-LSJ7DHXG.js";import"./chunk-LAOCC7HV.js";import{Ja as C,Ka as b}from"./chunk-5U3QUGIE.js";import"./chunk-M6F3L6JA.js";import"./chunk-ISE4SGOS.js";import"./chunk-QAOMSF4E.js";import"./chunk-L35YQFWA.js";import"./chunk-IKQFIZGK.js";import"./chunk-IJDSLHK6.js";import"./chunk-5GDNIVMJ.js";import"./chunk-7GRE4WMZ.js";import"./chunk-V6FGMHEW.js";import"./chunk-5IEIH52H.js";import"./chunk-IV5FR2YO.js";import{b as u}from"./chunk-FGSKM2Q7.js";import{Wa as a,ka as j}from"./chunk-DHATLY5R.js";import"./chunk-QCZJZLKO.js";import{ab as d}from"./chunk-BMCS4PVW.js";import"./chunk-2HUGHRMV.js";import{a as k,b as S}from"./chunk-AKQZC4JI.js";import"./chunk-3XBTBSJO.js";import"./chunk-VGKAVQRI.js";import"./chunk-JG6YPVA3.js";import"./chunk-TMJMA6BR.js";import"./chunk-JTYV7RXW.js";import{e as n}from"./chunk-KL2DZ7E2.js";var r=n(S(),1);var i=n(k(),1);var z=n(j(),1);var E={component:()=>{let t=C(),{onUserCloseViaDialogOrKeybindRef:m}=u(),x=d(),o=(0,i.useRef)(!1);(0,i.useEffect)((()=>{t&&(o.current=!1)}),[t]);let e=(0,i.useCallback)((async()=>{!o.current&&t&&(o.current=!0,b(),await t.onCancel())}),[t]);return(0,i.useEffect)((()=>(m.current=e,()=>{m.current===e&&(m.current=null)})),[e,m]),t?t.error?(0,r.jsx)(l,{icon:p,iconVariant:"warning",title:"Unable to add funds",subtitle:t.error,showClose:!0,onClose:e,primaryCta:{label:"Close",onClick:e}}):(0,r.jsx)(l,{icon:p,iconVariant:"subtle",title:"Select method",subtitle:"Choose how to fund your wallet",showClose:!0,onClose:e,children:(0,r.jsxs)(y,{style:{marginTop:"1rem"},$colorScheme:x.appearance.palette.colorScheme,children:[t.startFiat&&(0,r.jsxs)(c,{onClick:async()=>{o.current||(o.current=!0,await t.startFiat?.())},children:[(0,r.jsx)(g,{children:(0,r.jsx)(f,{})}),(0,r.jsxs)(w,{children:[(0,r.jsx)(s,{children:"Pay with fiat"}),(0,r.jsx)(v,{children:"Apple Pay, Google Pay, or debit card"})]})]}),t.startCrypto&&(0,r.jsxs)(c,{onClick:async()=>{o.current||(o.current=!0,await t.startCrypto?.())},children:[(0,r.jsx)(g,{children:(0,r.jsx)(h,{})}),(0,r.jsxs)(w,{children:[(0,r.jsx)(s,{children:"Transfer from wallet"}),(0,r.jsx)(v,{children:"Send crypto from any wallet"})]})]})]})}):null}},g=a.span`
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
