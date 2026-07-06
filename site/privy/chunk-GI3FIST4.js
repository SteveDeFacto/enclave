import{a as b}from"./chunk-6PFHC3TA.js";import{f as y}from"./chunk-I3B2SZVL.js";import{xa as c}from"./chunk-5U3QUGIE.js";import{Wa as o}from"./chunk-DHATLY5R.js";import{a as S,b as A}from"./chunk-AKQZC4JI.js";import{e as v}from"./chunk-KL2DZ7E2.js";var e=v(A(),1);var i=v(S(),1);var I=({currency:l="usd",value:d,onChange:n,inputMode:s="decimal",autoFocus:f})=>{let[p,x]=(0,i.useState)("0"),h=(0,i.useRef)(null),u=d??p,m=c[l]?.symbol??"$",k=(0,i.useCallback)((t=>{let r=t.target.value,a=(r=r.replace(/[^\d.]/g,"")).split(".");a.length>2&&(r=a[0]+"."+a.slice(1).join("")),a.length===2&&a[1].length>2&&(r=`${a[0]}.${a[1].slice(0,2)}`),r.length>1&&r[0]==="0"&&r[1]!=="."&&(r=r.slice(1)),(r===""||r===".")&&(r="0"),n?n(r):x(r)}),[n]),C=(0,i.useCallback)((t=>{!(["Delete","Backspace","Tab","Escape","Enter",".","ArrowLeft","ArrowRight","ArrowUp","ArrowDown","Home","End"].includes(t.key)||(t.ctrlKey||t.metaKey)&&["a","c","v","x"].includes(t.key.toLowerCase()))&&(t.key>="0"&&t.key<="9"||t.preventDefault())}),[]),g=(0,i.useMemo)((()=>(u.includes("."),u)),[u]);return(0,e.jsxs)(z,{onClick:()=>h.current?.focus(),children:[(0,e.jsx)(w,{children:m}),g,(0,e.jsx)("input",{ref:h,type:"text",inputMode:s,value:g,onChange:k,onKeyDown:C,autoFocus:f,placeholder:"0",style:{width:1,height:"1rem",opacity:0,alignSelf:"center",fontSize:"1rem"}}),(0,e.jsx)(w,{style:{opacity:0},children:m})]})},J=({selectedAsset:l,onEditSourceAsset:d})=>{let{icon:n}=c[l];return(0,e.jsxs)(j,{onClick:d,children:[(0,e.jsx)(D,{children:n}),(0,e.jsx)(L,{children:l.toLocaleUpperCase()}),(0,e.jsx)(E,{children:(0,e.jsx)(y,{})})]})},z=o.span`
  background-color: var(--privy-color-background);
  width: 100%;
  text-align: center;
  border: none;
  font-kerning: none;
  font-feature-settings: 'calt' off;
  display: flex;
  justify-content: center;
  align-items: flex-start;
  cursor: pointer;

  &:focus {
    outline: none !important;
    border: none !important;
    box-shadow: none !important;
  }

  && {
    color: var(--privy-color-foreground);
    font-size: 3.75rem;
    font-style: normal;
    font-weight: 600;
    line-height: 5.375rem;
  }
`,w=o.span`
  color: var(--privy-color-foreground);
  font-kerning: none;
  font-feature-settings: 'calt' off;
  font-size: 1rem;
  font-style: normal;
  font-weight: 600;
  line-height: 1.5rem;
  margin-top: 0.75rem;
`,j=o.button`
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: auto;
  gap: 0.5rem;
  border: 1px solid var(--privy-color-border-default);
  border-radius: var(--privy-border-radius-full);

  && {
    margin: auto;
    padding: 0.5rem 1rem;
  }
`,D=o.div`
  svg {
    width: 1rem;
    height: 1rem;
    border-radius: var(--privy-border-radius-full);
    overflow: hidden;
    border: solid 0.1px var(--privy-color-border-default);
  }
`,L=o.span`
  color: var(--privy-color-foreground);
  font-kerning: none;
  font-feature-settings: 'calt' off;
  font-size: 0.875rem;
  font-style: normal;
  font-weight: 500;
  line-height: 1.375rem;
`,E=o.div`
  color: var(--privy-color-foreground);

  svg {
    width: 1.25rem;
    height: 1.25rem;
  }
`,N=({opts:l,isLoading:d,onSelectSource:n})=>(0,e.jsx)(b,{showClose:!1,showBack:!0,onBack:()=>n(l.source.selectedAsset),title:"Select currency",children:(0,e.jsx)(B,{children:l.source.assets.map((s=>{let{icon:f,name:p}=c[s];return(0,e.jsx)(K,{onClick:()=>n(s),disabled:d,children:(0,e.jsxs)(M,{children:[(0,e.jsx)(U,{children:f}),(0,e.jsxs)($,{children:[(0,e.jsx)(F,{children:p}),(0,e.jsx)(R,{children:s.toLocaleUpperCase()})]})]})},s)}))})}),B=o.div`
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  width: 100%;
  max-height: 20.875rem;
  overflow-y: auto;
  scrollbar-width: none;

  &::-webkit-scrollbar {
    display: none;
  }
`,K=o.button`
  border-color: var(--privy-color-border-default);
  border-width: 1px;
  border-radius: var(--privy-border-radius-mdlg);
  border-style: solid;
  display: flex;

  && {
    padding: 0.75rem 1rem;
  }
`,M=o.div`
  display: flex;
  align-items: center;
  gap: 1rem;
  width: 100%;
`,U=o.div`
  svg {
    width: 2.25rem;
    height: 2.25rem;
    border-radius: var(--privy-border-radius-full);
    overflow: hidden;
    border: solid 0.1px var(--privy-color-border-default);
  }
`,$=o.div`
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 0.125rem;
`,F=o.span`
  color: var(--privy-color-foreground);
  font-size: 0.875rem;
  font-weight: 600;
  line-height: 1.25rem;
`,R=o.span`
  color: var(--privy-color-foreground-3);
  font-size: 0.75rem;
  font-weight: 400;
  line-height: 1.125rem;
`;export{I as a,J as b,N as c};
