import{Wa as n}from"./chunk-DHATLY5R.js";import{a as l,b as p}from"./chunk-AKQZC4JI.js";import{e}from"./chunk-KL2DZ7E2.js";var t=e(p(),1),i=e(l(),1);var d=o=>{let[a,r]=(0,i.useState)(!1);return(0,t.jsx)(s,{color:o.color,href:o.url,target:"_blank",rel:"noreferrer noopener",onClick:()=>{r(!0),setTimeout((()=>r(!1)),1500)},justOpened:a,children:o.text})},s=n.a`
  display: flex;
  align-items: center;
  gap: 6px;

  && {
    margin: 8px 2px;
    font-size: 14px;
    color: ${o=>o.justOpened?"var(--privy-color-foreground)":o.color||"var(--privy-color-foreground-3)"};
    font-weight: ${o=>o.justOpened?"medium":"normal"};
    transition: color 350ms ease;

    :focus,
    :active {
      background-color: transparent;
      border: none;
      outline: none;
      box-shadow: none;
    }

    :hover {
      color: ${o=>o.justOpened?"var(--privy-color-foreground)":"var(--privy-color-foreground-2)"};
    }

    :active {
      color: 'var(--privy-color-foreground)';
      font-weight: medium;
    }

    @media (max-width: 440px) {
      margin: 12px 2px;
    }
  }

  svg {
    width: 14px;
    height: 14px;
  }
`;export{d as a};
