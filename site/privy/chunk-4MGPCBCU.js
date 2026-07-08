import{N as l,e as c}from"./chunk-AIJD6O2L.js";import{Wa as e}from"./chunk-UGSP3DD6.js";import{a as p,b as d}from"./chunk-RYBZHIKX.js";import{e as n}from"./chunk-3IKZH76S.js";var r=n(d(),1);var a=n(p(),1);var h=e.div`
  display: flex;
  flex-direction: column;
  justify-content: flex-start;
  gap: 10px; /* 10px gap between items */
  padding-left: 8px; /* 8px indentation container */
`;e.div`
  &&& {
    margin-left: 6px; /* Center the line under the checkbox (12px/2) */
    border-left: 2px solid var(--privy-color-foreground-4);
    height: 10px; /* 10px H padding between paragraphs */
    margin-top: 0;
    margin-bottom: 0;
  }
`;var g=({children:o,variant:t="default",icon:i})=>{let s=()=>{switch(t){case"success":return"var(--privy-color-icon-success)";case"error":return"var(--privy-color-icon-error)";default:return"var(--privy-color-icon-muted)"}};return(0,r.jsxs)(f,{children:[(0,r.jsx)(u,{$variant:t,"data-variant":t,children:(()=>{if(i)return a.default.isValidElement(i)?a.default.cloneElement(i,{stroke:s(),strokeWidth:2}):i;switch(t){case"success":default:return(0,r.jsx)(c,{size:12,stroke:s(),strokeWidth:3});case"error":return(0,r.jsx)(l,{size:12,stroke:s(),strokeWidth:3})}})()}),o]})},u=e.div`
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background-color: ${({$variant:o})=>{switch(o){case"success":return"var(--privy-color-success-bg, #EAFCEF)";case"error":return"var(--privy-color-error-bg, #FEE2E2)";default:return"var(--privy-color-background-2)"}}};
  flex-shrink: 0;
`,f=e.div`
  display: flex;
  justify-content: flex-start;
  align-items: flex-start; /* Align all elements to the top */
  text-align: left;
  gap: 8px;

  && {
    a {
      color: var(--privy-color-accent);
    }
  }
`;export{h as a,g as b};
