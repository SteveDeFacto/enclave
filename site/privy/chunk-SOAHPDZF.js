import{Wa as i}from"./chunk-DHATLY5R.js";import{b as a}from"./chunk-AKQZC4JI.js";import{e as t}from"./chunk-KL2DZ7E2.js";var r=t(a(),1);var b=({className:e,checked:o,color:c="var(--privy-color-accent)",...s})=>(0,r.jsx)("label",{children:(0,r.jsxs)(n,{className:e,children:[(0,r.jsx)(d,{checked:o,...s}),(0,r.jsx)(p,{color:c,checked:o,children:(0,r.jsx)(l,{viewBox:"0 0 24 24",children:(0,r.jsx)("polyline",{points:"20 6 9 17 4 12"})})})]})});i.label`
  && {
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.75rem 1rem;
    text-align: left;
    border-radius: 0.5rem;
    border: 1px solid var(--privy-color-foreground-4);
    width: 100%;
  }
`;var n=i.div`
  display: inline-block;
  vertical-align: middle;
`,l=i.svg`
  fill: none;
  stroke: white;
  stroke-width: 3px;
`,d=i.input.attrs({type:"checkbox"})`
  border: 0;
  clip: rect(0 0 0 0);
  clippath: inset(50%);
  height: 1px;
  margin: -1px;
  overflow: hidden;
  padding: 0;
  position: absolute;
  white-space: nowrap;
  width: 1px;
`,p=i.div`
  display: inline-block;
  width: 18px;
  height: 18px;
  transition: all 150ms;
  cursor: pointer;
  border-color: ${e=>e.color};
  border-radius: 3px;
  background: ${e=>e.checked?e.color:"var(--privy-color-background)"};

  && {
    /* This is necessary to override css reset for border width */
    border-width: 1px;
  }

  ${d}:focus + & {
    box-shadow: 0 0 0 1px ${e=>e.color};
  }

  ${l} {
    visibility: ${e=>e.checked?"visible":"hidden"};
  }
`;export{b as a};
