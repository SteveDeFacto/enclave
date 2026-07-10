import{a,b as n,c as l}from"./chunk-SJMJLBMK.js";import{f as i,g as t}from"./chunk-LAOCC7HV.js";import{Va as o,Wa as r}from"./chunk-DHATLY5R.js";var p=o`
  font-size: 14px;
  font-style: normal;
  font-weight: 400;
  line-height: 20px;
  letter-spacing: -0.008px;
  text-align: left;
  transition: color 0.1s ease-in;
`,h=r.span`
  ${p}
  transition: color 0.1s ease-in;
  color: ${({error:e})=>e?"var(--privy-color-error)":"var(--privy-color-foreground-3)"};
  text-transform: ${({error:e})=>e?"":"capitalize"};

  &[aria-hidden='true'] {
    visibility: hidden;
  }
`,x=r.div`
  display: flex;
  flex-direction: column;
  justify-content: center;
  flex-grow: 1;
`,m=r(t)`
  ${({$hideAnimations:e})=>e&&o`
      && {
        transition: none;
      }
    `}
`,s=o`
  && {
    width: 100%;
    border-width: 1px;
    border-radius: var(--privy-border-radius-md);
    border-color: var(--privy-color-foreground-3);
    background: var(--privy-color-background);
    color: var(--privy-color-foreground);

    padding: 12px;
    font-size: 16px;
    font-style: normal;
    font-weight: 300;
    line-height: 22px; /* 137.5% */
  }
`,y=r.input`
  ${s}

  &::placeholder {
    color: var(--privy-color-foreground-3);
    font-style: italic;
    font-size: 14px;
  }

  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`,u=r.div`
  ${s}
`,w=r.div`
  position: relative;
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: ${({centered:e})=>e?"center":"space-between"};
`,b=r.div`
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  margin: 32px 0;
  gap: 4px;

  & h3 {
    font-size: 18px;
    font-style: normal;
    font-weight: 600;
    line-height: 24px;
  }

  & p {
    max-width: 300px;
    font-size: 14px;
    font-style: normal;
    font-weight: 400;
    line-height: 20px;
  }
`,k=r.div`
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding-bottom: 1rem;
`,$=r.div`
  display: flex;
  text-align: left;
  align-items: center;

  gap: 8px;
  max-width: 300px;

  font-size: 14px;
  font-style: normal;
  font-weight: 400;
  line-height: 20px;
  letter-spacing: -0.008px;

  margin: 0 8px;
  color: var(--privy-color-foreground-2);

  > :first-child {
    min-width: 24px;
  }
`;r.div`
  height: var(--privy-height-modal-full);

  @media (max-width: 440px) {
    height: var(--privy-height-modal-compact);
  }
`;var z=r(i)`
  display: flex;
  flex: 1;
  gap: 4px;
  justify-content: center;

  && {
    background: var(--privy-color-background);
    border-radius: var(--privy-border-radius-md);
    border-color: var(--privy-color-foreground-3);
    border-width: 1px;
  }
`,j=r.div`
  position: absolute;
  right: 0.5rem;

  display: flex;
  flex-direction: row;
  justify-content: space-around;
  align-items: center;
`,P=r(a)`
  height: 1.25rem;
  width: 1.25rem;
  stroke: var(--privy-color-accent);
  cursor: pointer;

  :active {
    stroke: var(--privy-color-accent-light);
  }
`,S=r(n)`
  height: 1.25rem;
  width: 1.25rem;
  stroke: var(--privy-color-accent);
  cursor: pointer;

  :active {
    stroke: var(--privy-color-accent-light);
  }
`,A=r(l)`
  height: 1.25rem;
  width: 1.25rem;
  stroke: var(--privy-color-accent);
  cursor: pointer;

  :active {
    stroke: var(--privy-color-accent-light);
  }
`,D=r.progress`
  height: 4px;
  width: 100%;
  margin: 8px 0;

  /* border-radius: 9999px; */
  ::-webkit-progress-bar {
    border-radius: 8px;
    background: var(--privy-color-foreground-4);
  }

  ::-webkit-progress-value {
    border-radius: 8px;
    transition: all 0.1s ease-out;
    background: ${({label:e})=>(e==="Strong"?"#78dca6":e==="Medium"&&"var(--privy-color-warn)")||"var(--privy-color-error)"};
  }
`;export{h as a,x as b,m as c,y as d,u as e,w as f,b as g,k as h,$ as i,z as j,j as k,P as l,S as m,A as n,D as o};
