import{a as u}from"./chunk-MVHCFRZI.js";import{h as f}from"./chunk-YATND2IE.js";import{b as l,c,e as d,f as x}from"./chunk-PWN464GZ.js";import{M as h,Wa as s}from"./chunk-DHATLY5R.js";import{b}from"./chunk-AKQZC4JI.js";import{hb as p}from"./chunk-TMJMA6BR.js";import{e as v}from"./chunk-KL2DZ7E2.js";var e=v(b(),1);var Q=({weiQuantities:r,tokenPrice:n,tokenSymbol:o})=>{let i=d(r),t=n?l(i,n):void 0,a=c(i,o);return(0,e.jsx)(m,{children:t||a})},U=({weiQuantities:r,tokenPrice:n,tokenSymbol:o})=>{let i=d(r),t=n?l(i,n):void 0,a=c(i,o);return(0,e.jsx)(m,{children:t?(0,e.jsxs)(e.Fragment,{children:[(0,e.jsx)(w,{children:"USD"}),t==="<$0.01"?(0,e.jsxs)(k,{children:[(0,e.jsx)(g,{children:"<"}),"$0.01"]}):t]}):a})},q=({quantities:r,tokenPrice:n,tokenSymbol:o="SOL",tokenDecimals:i=9})=>{let t=r.reduce(((S,$)=>S+$),0n),a=n&&o==="SOL"&&i===9?f(t,n):void 0,y=o==="SOL"&&i===9?u(t):`${p(t,i)} ${o}`;return(0,e.jsx)(m,{children:a?(0,e.jsx)(e.Fragment,{children:a==="<$0.01"?(0,e.jsxs)(k,{children:[(0,e.jsx)(g,{children:"<"}),"$0.01"]}):a}):y})},m=s.span`
  font-size: 14px;
  line-height: 140%;
  display: flex;
  gap: 4px;
  align-items: center;
`,w=s.span`
  font-size: 12px;
  line-height: 12px;
  color: var(--privy-color-foreground-3);
`,g=s.span`
  font-size: 10px;
`,k=s.span`
  display: flex;
  align-items: center;
`;function P(r,n){return`https://explorer.solana.com/account/${r}?chain=${n}`}var F=r=>(0,e.jsx)(z,{href:r.chainType==="ethereum"?x(r.chainId,r.walletAddress):P(r.walletAddress,r.chainId),target:"_blank",children:h(r.walletAddress)}),z=s.a`
  &:hover {
    text-decoration: underline;
  }
`;export{Q as a,U as b,q as c,F as d};
