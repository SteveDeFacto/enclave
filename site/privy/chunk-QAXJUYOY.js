import{d as r}from"./chunk-2LOXYHI5.js";import{k as o}from"./chunk-LAOCC7HV.js";import{Wa as t,Ya as i}from"./chunk-DHATLY5R.js";var d=t.div`
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding-top: 24px;
  padding-bottom: 24px;
`,c=t.div`
  width: 24px;
  height: 24px;
  display: flex;
  justify-content: center;
  align-items: center;

  svg {
    border-radius: var(--privy-border-radius-sm);
  }
`,x=t.div`
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: flex-start;
  gap: 8px;
`,l=t.div`
  display: flex;
  align-items: center;
  gap: 4px;
  width: 100%;
  padding: 0 16px;
  border-width: 1px !important;
  border-radius: 12px;
  cursor: text;

  &:focus-within {
    border-color: var(--privy-color-accent);
  }
`;t.div`
  font-size: 42px !important;
`;var e=t.input`
  background-color: var(--privy-color-background);
  width: 100%;

  &:focus {
    outline: none !important;
    border: none !important;
    box-shadow: none !important;
  }

  && {
    font-size: 26px;
  }
`,f=t(e)`
  && {
    font-size: 42px;
  }
`;t.button`
  cursor: pointer;
  padding-left: 4px;
`;var m=t.div`
  font-size: 18px;
`,g=t.div`
  font-size: 12px;
  color: var(--privy-color-foreground-3);
  // we need this container to maintain a static height if there's no content
  height: 20px;
`;t.div`
  display: flex;
  flex-direction: row;
  line-height: 22px;
  font-size: 16px;
  text-align: center;
  svg {
    margin-right: 6px;
    margin: auto;
  }
`,t(r)`
  margin-top: 16px;
`;var n=i`
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
`;t(o)`
  border-radius: var(--privy-border-radius-md) !important;
  animation: ${n} 0.3s ease-in-out;
`;var u=t.div``,v=t.a`
  && {
    color: var(--privy-color-accent);
  }

  cursor: pointer;
`;export{d as a,c as b,x as c,l as d,e,f,m as g,g as h,u as i,v as j};
