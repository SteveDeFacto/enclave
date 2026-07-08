import{a as U}from"./chunk-HI7TAG2Y.js";import{g as V,l as z}from"./chunk-3TPGN3TC.js";import{Wa as s,ob as T}from"./chunk-UGSP3DD6.js";import{aa as C,ab as S,ba as l,ca as u,ea as k,fa as N,ga as P,ha as $}from"./chunk-OV7GNHZT.js";import{a as I,b as A}from"./chunk-RYBZHIKX.js";import{e as w}from"./chunk-3IKZH76S.js";var r=w(A(),1),n=w(I(),1);var K=({value:e,onChange:p})=>(0,r.jsx)("select",{value:e,onChange:p,children:N.map(d=>(0,r.jsxs)("option",{value:d.code,children:[d.code," +",d.callCode]},d.code))}),Y=(0,n.forwardRef)((e,p)=>{let d=S(),[E,L]=(0,n.useState)(!1),{accountType:q}=T(),[a,g]=(0,n.useState)(""),[t,R]=(0,n.useState)(e.defaultCountry??d?.intl.defaultCountry??"US"),j=l(a,t),m=k(t),B=P(t),D=C(t),b=!j,[f,x]=(0,n.useState)(!1),F=D.length,v=o=>{let i=o.target.value;R(i),g(""),e.onChange&&e.onChange({rawPhoneNumber:a,qualifiedPhoneNumber:u(a,i),countryCode:i,isValid:l(a,t)})},y=(o,i)=>{try{let c=o.replace(/\D/g,"")===a.replace(/\D/g,"")?o:m.input(o);g(c),e.onChange&&e.onChange({rawPhoneNumber:c,qualifiedPhoneNumber:u(o,i),countryCode:i,isValid:l(o,i)})}catch(c){console.error("Error processing phone number:",c)}},h=()=>{x(!0);let o=u(a,t);e.onSubmit({rawPhoneNumber:a,qualifiedPhoneNumber:o,countryCode:t,isValid:l(a,t)}).finally(()=>x(!1))};return(0,n.useEffect)(()=>{if(e.defaultValue){let o=$(e.defaultValue);m.reset(),v({target:{value:o.countryCode}}),y(o.phone,o.countryCode)}},[e.defaultValue]),(0,r.jsxs)(r.Fragment,{children:[(0,r.jsx)(G,{children:(0,r.jsxs)(H,{$callingCodeLength:F,$stacked:e.stacked,children:[(0,r.jsx)(K,{value:t,onChange:v}),(0,r.jsx)("input",{ref:p,id:"phone-number-input",className:"login-method-button",type:"tel",placeholder:B,onFocus:()=>L(!0),onChange:o=>{y(o.target.value,t)},onKeyUp:o=>{o.key==="Enter"&&h()},value:a,autoComplete:"tel"}),q!=="phone"||E||e.hideRecent?e.stacked||e.noIncludeSubmitButton?(0,r.jsx)("span",{}):(0,r.jsx)(z,{isSubmitting:f,onClick:h,disabled:b,children:"Submit"}):(0,r.jsx)(U,{color:"gray",children:"Recent"})]})}),e.stacked&&!e.noIncludeSubmitButton?(0,r.jsx)(V,{loading:f,loadingText:null,onClick:h,disabled:b,children:"Submit"}):null]})}),G=s.div`
  width: 100%;
`,H=s.label`
  --country-code-dropdown-width: calc(54px + calc(12 * ${e=>e.$callingCodeLength}px));
  --phone-input-extra-padding-left: calc(12px + calc(3 * ${e=>e.$callingCodeLength}px));
  display: block;
  position: relative;
  width: 100%;

  /* Tablet and Up */
  @media (min-width: 441px) {
    --country-code-dropdown-width: calc(52px + calc(10 * ${e=>e.$callingCodeLength}px));
  }

  && > select {
    font-size: 16px;
    height: 24px;
    position: absolute;
    margin: 13px calc(var(--country-code-dropdown-width) / 4);
    line-height: 24px;
    width: var(--country-code-dropdown-width);
    background-color: var(--privy-color-background);
    background-size: auto;
    background-position-x: right;
    cursor: pointer;

    /* Tablet and Up */
    @media (min-width: 441px) {
      font-size: 14px;
      width: var(--country-code-dropdown-width);
    }

    :focus {
      outline: none;
      box-shadow: none;
    }
  }

  && > input {
    font-size: 16px;
    line-height: 24px;
    color: var(--privy-color-foreground);

    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;

    width: calc(100% - var(--country-code-dropdown-width));

    padding: 12px 88px 12px
      calc(var(--country-code-dropdown-width) + var(--phone-input-extra-padding-left));
    padding-right: ${e=>e.$stacked?"16px":"88px"};
    flex-grow: 1;
    background: var(--privy-color-background);
    border: 1px solid var(--privy-color-foreground-4);
    border-radius: var(--privy-border-radius-md);
    width: 100%;

    :focus {
      outline: none;
      border-color: var(--privy-color-accent);
    }

    :autofill,
    :-webkit-autofill {
      background: var(--privy-color-background);
    }

    /* Tablet and Up */
    @media (min-width: 441px) {
      font-size: 14px;
      padding-right: 78px;
    }
  }

  && > :last-child {
    right: 16px;
    position: absolute;
    top: 50%;
    transform: translate(0, -50%);
  }

  && > button:last-child {
    right: 0px;
    line-height: 24px;
    padding: 13px 17px;

    :focus {
      outline: none;
      border-color: var(--privy-color-accent);
    }
  }

  && > input::placeholder {
    color: var(--privy-color-foreground-3);
  }
`;export{Y as a};
