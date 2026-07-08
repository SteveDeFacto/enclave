import{a as x}from"./chunk-OZ5DZKV5.js";import{b as g}from"./chunk-VG5ZWMSY.js";import{a as h}from"./chunk-LRGIVOAE.js";import{a as u}from"./chunk-TF4QA2ZZ.js";import{e as d,o as p}from"./chunk-AIJD6O2L.js";import{i as f}from"./chunk-3TPGN3TC.js";import{Wa as r}from"./chunk-UGSP3DD6.js";import{a as C,b as w}from"./chunk-RYBZHIKX.js";import{e as c}from"./chunk-3IKZH76S.js";var e=c(w(),1);var o=c(C(),1);var b=r(g)`
  && {
    padding: 0.75rem;
    height: 56px;
  }
`,z=r.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
`,j=r.div`
  display: flex;
  flex-direction: column;
  gap: 0;
`,T=r.div`
  font-size: 12px;
  line-height: 1rem;
  color: var(--privy-color-foreground-3);
`,k=r(x)`
  text-align: left;
  margin-bottom: 0.5rem;
`,B=r(h)`
  margin-top: 0.25rem;
`,E=r(f)`
  && {
    gap: 0.375rem;
    font-size: 14px;
  }
`,P=({errMsg:i,balance:a,address:n,className:v,title:l,showCopyButton:y=!1})=>{let[t,m]=(0,o.useState)(!1);return(0,o.useEffect)(()=>{if(t){let s=setTimeout(()=>m(!1),3e3);return()=>clearTimeout(s)}},[t]),(0,e.jsxs)("div",{children:[l&&(0,e.jsx)(k,{children:l}),(0,e.jsx)(b,{className:v,$state:i?"error":void 0,children:(0,e.jsxs)(z,{children:[(0,e.jsxs)(j,{children:[(0,e.jsx)(u,{address:n,showCopyIcon:!1}),a!==void 0&&(0,e.jsx)(T,{children:a})]}),y&&(0,e.jsx)(E,{onClick:function(s){s.stopPropagation(),navigator.clipboard.writeText(n).then(()=>m(!0)).catch(console.error)},size:"sm",children:(0,e.jsxs)(e.Fragment,t?{children:["Copied",(0,e.jsx)(d,{size:14})]}:{children:["Copy",(0,e.jsx)(p,{size:14})]})})]})}),i&&(0,e.jsx)(B,{children:i})]})};export{P as a};
