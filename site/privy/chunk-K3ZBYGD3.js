import{e as m,o as u}from"./chunk-I3B2SZVL.js";import{Wa as o}from"./chunk-DHATLY5R.js";import{a as y,b as x}from"./chunk-AKQZC4JI.js";import{e as p}from"./chunk-KL2DZ7E2.js";var e=p(x(),1);var d=p(y(),1);var a=o.button`
  display: flex;
  align-items: center;
  justify-content: end;
  gap: 0.5rem;

  && {
    color: var(--privy-color-foreground);
    font-weight: 500;
  }

  svg {
    width: 0.875rem;
    height: 0.875rem;
  }
`,f=o.span`
  display: flex;
  align-items: center;
  gap: 0.25rem;
  font-size: 0.875rem;
  color: var(--privy-color-foreground-2);
`,g=o(m)`
  color: var(--privy-color-icon-success);
  flex-shrink: 0;
`,v=o(u)`
  color: var(--privy-color-icon-muted);
  flex-shrink: 0;
`;function w({children:r,iconOnly:s,value:i,hideCopyIcon:n,iconSize:t=14,...c}){let[l,h]=(0,d.useState)(!1);return(0,e.jsxs)(a,{...c,onClick:()=>{navigator.clipboard.writeText(i||(typeof r=="string"?r:"")).catch(console.error),h(!0),setTimeout((()=>h(!1)),1500)},children:[r," ",l?(0,e.jsxs)(f,{children:[(0,e.jsx)(g,{size:t})," ",!s&&"Copied"]}):!n&&(0,e.jsx)(v,{size:t})]})}var z=({value:r,includeChildren:s,children:i,...n})=>{let[t,c]=(0,d.useState)(!1),l=()=>{navigator.clipboard.writeText(r).catch(console.error),c(!0),setTimeout((()=>c(!1)),1500)};return(0,e.jsxs)(e.Fragment,{children:[s?(0,e.jsx)(a,{...n,onClick:l,children:i}):(0,e.jsx)(e.Fragment,{children:i}),(0,e.jsx)(a,{...n,onClick:l,children:t?(0,e.jsx)(f,{children:(0,e.jsx)(g,{})}):(0,e.jsx)(v,{})})]})};export{w as a,z as b};
