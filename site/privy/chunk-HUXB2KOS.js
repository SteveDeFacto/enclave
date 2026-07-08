import{Wa as i}from"./chunk-UGSP3DD6.js";import{b as c}from"./chunk-RYBZHIKX.js";import{e as a}from"./chunk-3IKZH76S.js";var r=a(c(),1);var p=({title:n,description:t,children:e,...o})=>(0,r.jsx)(l,{...o,children:(0,r.jsxs)(r.Fragment,{children:[(0,r.jsx)("h3",{children:n}),typeof t=="string"?(0,r.jsx)("p",{children:t}):t,e]})});i(p)`
  margin-bottom: 24px;
`;var h=({title:n,description:t,icon:e,children:o,...s})=>(0,r.jsxs)(d,{...s,children:[e||null,(0,r.jsx)("h3",{children:n}),t&&typeof t=="string"?(0,r.jsx)("p",{children:t}):t,o]}),l=i.div`
  display: flex;
  flex-direction: column;
  justify-content: flex-start;
  align-items: flex-start;
  text-align: left;
  gap: 8px;
  width: 100%;
  margin-bottom: 24px;

  && h3 {
    font-size: 17px;
    color: var(--privy-color-foreground);
  }

  /* Sugar assuming children are paragraphs. Otherwise, handling styling on your own */
  && p {
    color: var(--privy-color-foreground-2);
    font-size: 14px;
  }
`,d=i(l)`
  align-items: center;
  text-align: center;
  gap: 16px;

  h3 {
    margin-bottom: 24px;
  }
`;export{p as a,h as b};
