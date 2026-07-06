import{a as w,b as u,d as f}from"./chunk-RVEDV7GG.js";import{c as g}from"./chunk-PWN464GZ.js";import{a as b}from"./chunk-RQYZCUZG.js";import{f as v}from"./chunk-ARRVTVNF.js";import{Wa as r}from"./chunk-DHATLY5R.js";import{Ta as p,ab as y}from"./chunk-BMCS4PVW.js";import{a as T,b as A}from"./chunk-AKQZC4JI.js";import{e as m}from"./chunk-KL2DZ7E2.js";var e=m(A(),1);var d=m(T(),1);var x=({label:i,children:n,valueStyles:t})=>(0,e.jsxs)(F,{children:[(0,e.jsx)("div",{children:i}),(0,e.jsx)(z,{style:{...t},children:n})]}),F=r.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;

  > :first-child {
    color: var(--privy-color-foreground-3);
    text-align: left;
  }

  > :last-child {
    color: var(--privy-color-foreground-2);
    text-align: right;
  }
`,z=r.div`
  font-size: 14px;
  line-height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--privy-border-radius-full);
  background-color: var(--privy-color-background-2);
  padding: 4px 8px;
`,C=({gas:i,tokenPrice:n,tokenSymbol:t})=>(0,e.jsxs)(v,{style:{paddingBottom:"12px"},children:[(0,e.jsxs)(k,{children:[(0,e.jsx)(S,{children:"Est. Fees"}),(0,e.jsx)("div",{children:(0,e.jsx)(u,{weiQuantities:[BigInt(i)],tokenPrice:n,tokenSymbol:t})})]}),n&&(0,e.jsx)(P,{children:`${g(BigInt(i),t)}`})]}),Q=({value:i,gas:n,tokenPrice:t,tokenSymbol:o})=>{let l=BigInt(i??0)+BigInt(n);return(0,e.jsxs)(v,{children:[(0,e.jsxs)(k,{children:[(0,e.jsx)(S,{children:"Total (including fees)"}),(0,e.jsx)("div",{children:(0,e.jsx)(u,{weiQuantities:[BigInt(i||0),BigInt(n)],tokenPrice:t,tokenSymbol:o})})]}),t&&(0,e.jsx)(P,{children:g(l,o)})]})},k=r.div`
  display: flex;
  flex-direction: row;
  justify-content: space-between;
  align-items: center;
  padding-top: 4px;
`,P=r.div`
  display: flex;
  flex-direction: row;
  height: 12px;

  font-size: 12px;
  line-height: 12px;
  color: var(--privy-color-foreground-3);
  font-weight: 400;
`,S=r.div`
  font-size: 14px;
  line-height: 22.4px;
  font-weight: 400;
`,a=(0,d.createContext)(void 0),c=(0,d.createContext)(void 0),V=({defaultValue:i,children:n})=>{let[t,o]=(0,d.useState)(i||null);return(0,e.jsx)(a.Provider,{value:{activePanel:t,togglePanel:l=>{o(t===l?null:l)}},children:(0,e.jsx)(H,{children:n})})},W=({value:i,children:n})=>{let{activePanel:t,togglePanel:o}=(0,d.useContext)(a),l=t===i;return(0,e.jsx)(c.Provider,{value:{onToggle:()=>o(i),value:i},children:(0,e.jsx)(J,{isActive:l?"true":"false","data-open":String(l),children:n})})},$=({children:i})=>{let{activePanel:n}=(0,d.useContext)(a),{onToggle:t,value:o}=(0,d.useContext)(c),l=n===o;return(0,e.jsxs)(e.Fragment,{children:[(0,e.jsxs)(L,{onClick:t,"data-open":String(l),children:[(0,e.jsx)(G,{children:i}),(0,e.jsx)(M,{isactive:l?"true":"false",children:(0,e.jsx)(b,{height:"16px",width:"16px",strokeWidth:"2"})})]}),(0,e.jsx)(q,{})]})},D=({children:i})=>{let{activePanel:n}=(0,d.useContext)(a),{value:t}=(0,d.useContext)(c);return(0,e.jsx)(K,{"data-open":String(n===t),children:(0,e.jsx)(I,{children:i})})},E=({children:i})=>{let{activePanel:n}=(0,d.useContext)(a),{value:t}=(0,d.useContext)(c);return(0,e.jsx)(I,{children:typeof i=="function"?i({isActive:n===t}):i})},H=r.div`
  display: flex;
  flex-direction: column;
  width: 100%;
  gap: 8px;
`,L=r.div`
  display: flex;
  justify-content: space-between;
  align-items: center;
  width: 100%;
  cursor: pointer;
  padding-bottom: 8px;
`,q=r.div`
  width: 100%;

  && {
    border-top: 1px solid;
    border-color: var(--privy-color-foreground-4);
  }
  padding-bottom: 12px;
`,G=r.div`
  font-size: 14px;
  font-weight: 500;
  line-height: 19.6px;
  width: 100%;
  padding-right: 8px;
`,J=r.div`
  display: flex;
  flex-direction: column;
  width: 100%;
  overflow: hidden;
  padding: 12px;

  && {
    border: 1px solid;
    border-color: var(--privy-color-foreground-4);
    border-radius: var(--privy-border-radius-md);
  }
`,K=r.div`
  position: relative;
  overflow: hidden;
  transition: max-height 25ms ease-out;

  &[data-open='true'] {
    max-height: 700px;
  }

  &[data-open='false'] {
    max-height: 0;
  }
`,I=r.div`
  display: flex;
  flex-direction: column;
  gap: 12px;
  flex: 1 1 auto;
  min-height: 1px;
`,M=r.div`
  transform: ${i=>i.isactive==="true"?"rotate(180deg)":"rotate(0deg)"};
`,ee=({from:i,to:n,txn:t,transactionInfo:o,tokenPrice:l,gas:s,tokenSymbol:h})=>{let B=BigInt(t?.value||0);return(0,e.jsx)(V,{...y().render.standalone?{defaultValue:"details"}:{},children:(0,e.jsxs)(W,{value:"details",children:[(0,e.jsx)($,{children:(0,e.jsxs)(N,{children:[(0,e.jsx)("div",{children:o?.title||"Details"}),(0,e.jsx)(O,{children:(0,e.jsx)(w,{weiQuantities:[B],tokenPrice:l,tokenSymbol:h})})]})}),(0,e.jsxs)(D,{children:[(0,e.jsx)(x,{label:"From",children:(0,e.jsx)(f,{walletAddress:i,chainId:t.chainId||p,chainType:"ethereum"})}),(0,e.jsx)(x,{label:"To",children:(0,e.jsx)(f,{walletAddress:n,chainId:t.chainId||p,chainType:"ethereum"})}),o&&o.action&&(0,e.jsx)(x,{label:"Action",children:o.action}),s&&(0,e.jsx)(C,{value:t.value,gas:s,tokenPrice:l,tokenSymbol:h})]}),(0,e.jsx)(E,{children:({isActive:j})=>(0,e.jsx)(Q,{value:t.value,displayFee:j,gas:s||"0x0",tokenPrice:l,tokenSymbol:h})})]})})},N=r.div`
  display: flex;
  flex-direction: row;
  justify-content: space-between;
`,O=r.div`
  flex-shrink: 0;
  padding-left: 8px;
`;export{ee as a};
