import{Wa as a}from"./chunk-UGSP3DD6.js";import{b as s}from"./chunk-RYBZHIKX.js";import{e as l}from"./chunk-3IKZH76S.js";var r=l(s(),1);var d=({data:t})=>{let e=o=>typeof o=="object"&&o!==null?(0,r.jsx)(p,{children:Object.entries(o).map(([i,n])=>(0,r.jsxs)("li",{children:[(0,r.jsxs)("strong",{children:[i,":"]})," ",e(n)]},i))}):(0,r.jsx)("span",{children:String(o)});return(0,r.jsx)("div",{children:e(t)})},c=a.div`
  margin-top: 1.5rem;
  background-color: var(--privy-color-background-2);
  border-radius: var(--privy-border-radius-md);
  padding: 12px;
  text-align: left;
  max-height: 310px;
  overflow: scroll;
  white-space: pre-wrap;
  width: 100%;
  font-size: 0.875rem;
  font-weight: 400;
  color: var(--privy-color-foreground);
  line-height: 1.5;

  // hide the scrollbars
  -ms-overflow-style: none; /* Internet Explorer 10+ */
  scrollbar-width: none; /* Firefox */

  &::-webkit-scrollbar {
    display: none; /* Safari and Chrome */
  }
`,p=a.ul`
  margin-left: 12px !important;
  white-space: nowrap;

  &:first-child {
    margin-left: 0 !important;
  }

  strong {
    font-weight: 500 !important;
  }
`,m=({data:t,className:e})=>(0,r.jsx)(c,{className:e,children:(0,r.jsx)(d,{data:t})});export{c as a,m as b};
