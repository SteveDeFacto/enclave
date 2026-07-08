import{a as X}from"./chunk-B6XZPB7J.js";import{a as Y}from"./chunk-V3TZHIUJ.js";import{a as Q}from"./chunk-7AZYLBCT.js";import{c as Z}from"./chunk-STCN3NYB.js";import{a as H}from"./chunk-HVZ7ZTL2.js";import{a as z}from"./chunk-EPTHIVTU.js";import"./chunk-7QNQM5YS.js";import"./chunk-QSYOL7C5.js";import"./chunk-3TPGN3TC.js";import"./chunk-FV2AAPQX.js";import"./chunk-CJPO3VTC.js";import"./chunk-ESV6JEIL.js";import"./chunk-QAOMSF4E.js";import"./chunk-3ZWNU7CV.js";import"./chunk-5VJVPF2Z.js";import"./chunk-BOEOVMBZ.js";import"./chunk-AA7RRP2U.js";import"./chunk-UM4F4LLA.js";import"./chunk-PQCP3NT5.js";import"./chunk-7DSUPGAS.js";import"./chunk-IV5FR2YO.js";import{b as K}from"./chunk-FVYEL4IS.js";import{B as v,F as V,Wa as g,e as B,ka as ie,r as q,v as f}from"./chunk-UGSP3DD6.js";import"./chunk-QCZJZLKO.js";import{ab as P,xa as U}from"./chunk-OV7GNHZT.js";import"./chunk-AD5BZVLA.js";import{a as F,b as te}from"./chunk-RYBZHIKX.js";import"./chunk-EFK6JAUM.js";import"./chunk-JVFQFJH5.js";import"./chunk-VHIR2IYC.js";import"./chunk-LYIDHH4Z.js";import"./chunk-JTYV7RXW.js";import{e as k}from"./chunk-3IKZH76S.js";var r=k(te(),1);var w=k(F(),1);function ae({title:o,titleId:d,...S},p){return w.createElement("svg",Object.assign({xmlns:"http://www.w3.org/2000/svg",viewBox:"0 0 20 20",fill:"currentColor","aria-hidden":"true","data-slot":"icon",ref:p,"aria-labelledby":d},S),o?w.createElement("title",{id:d},o):null,w.createElement("path",{fillRule:"evenodd",d:"M16.704 4.153a.75.75 0 0 1 .143 1.052l-8 10.5a.75.75 0 0 1-1.127.075l-4.5-4.5a.75.75 0 0 1 1.06-1.06l3.894 3.893 7.48-9.817a.75.75 0 0 1 1.05-.143Z",clipRule:"evenodd"}))}var ne=w.forwardRef(ae),G=ne;var s=k(F(),1),oe=k(ie(),1);var se=({contactMethod:o,authFlow:d,emailDomain:S,appName:p="Privy",whatsAppEnabled:I=!1,onBack:E,onCodeSubmit:M,onResend:L,errorMessage:m,success:h=!1,resendCountdown:D=0,onInvalidInput:O,onClearError:N})=>{let[c,C]=(0,s.useState)(ee);(0,s.useEffect)(()=>{m||C(ee)},[m]);let x=async y=>{y.preventDefault();let t=y.currentTarget.value.replace(" ","");if(t==="")return;if(isNaN(Number(t)))return void O?.("Code should be numeric");N?.();let u=Number(y.currentTarget.name?.charAt(5)),a=[...t||[""]].slice(0,J-u),n=[...c.slice(0,u),...a,...c.slice(u+a.length)];C(n);let b=Math.min(Math.max(u+a.length,0),J-1);isNaN(Number(y.currentTarget.value))||document.querySelector(`input[name=code-${b}]`)?.focus(),n.every(l=>l&&!isNaN(+l))&&(document.querySelector(`input[name=code-${b}]`)?.blur(),await M?.(n.join("")))};return(0,r.jsx)(z,{title:"Enter confirmation code",subtitle:(0,r.jsxs)("span",d==="email"?{children:["Please check ",(0,r.jsx)(re,{children:o})," for an email from"," ",S??"privy.io"," and enter your code below."]}:{children:["Please check ",(0,r.jsx)(re,{children:o})," for a",I?" WhatsApp":""," message from ",p," and enter your code below."]}),icon:d==="email"?X:Y,onBack:E,showBack:!0,helpText:(0,r.jsxs)(ue,{children:[(0,r.jsxs)("span",{children:["Didn't get ",d==="email"?"an email":"a message","?"]}),D?(0,r.jsxs)(fe,{children:[(0,r.jsx)(G,{color:"var(--privy-color-foreground)",strokeWidth:1.33,height:"12px",width:"12px"}),(0,r.jsx)("span",{children:"Code sent"})]}):(0,r.jsx)(Q,{as:"button",size:"sm",onClick:L,children:"Resend code"})]}),children:(0,r.jsx)(de,{children:(0,r.jsx)(Z,{children:(0,r.jsxs)(pe,{children:[(0,r.jsx)("div",{children:c.map((y,t)=>(0,r.jsx)("input",{name:`code-${t}`,type:"text",value:c[t],onChange:x,onKeyUp:u=>{u.key==="Backspace"&&(a=>{N?.(),C([...c.slice(0,a),"",...c.slice(a+1)]),a>0&&document.querySelector(`input[name=code-${a-1}]`)?.focus()})(t)},inputMode:"numeric",autoFocus:t===0,pattern:"[0-9]",className:`${h?"success":""} ${m?"fail":""}`,autoComplete:oe.isMobile?"one-time-code":"off"},t))}),(0,r.jsx)(me,{$fail:!!m,$success:h,children:(0,r.jsx)("span",{children:m==="Invalid or expired verification code"?"Incorrect code":m||(h?"Success!":"")})})]})})})})},J=6,ee=Array(6).fill(""),A,T,le=((A=le||{})[A.RESET_AFTER_DELAY=0]="RESET_AFTER_DELAY",A[A.CLEAR_ON_NEXT_VALID_INPUT=1]="CLEAR_ON_NEXT_VALID_INPUT",A),ce=((T=ce||{})[T.EMAIL=0]="EMAIL",T[T.SMS=1]="SMS",T),Le={component:()=>{let{navigate:o,lastScreen:d,navigateBack:S,setModalData:p,onUserCloseViaDialogOrKeybindRef:I}=K(),E=P(),{closePrivyModal:M,resendEmailCode:L,resendSmsCode:m,getAuthMeta:h,loginWithCode:D,updateWallets:O,createAnalyticsEvent:N}=B(),{authenticated:c,logout:C,user:x}=q(),{whatsAppEnabled:y}=P(),[t,u]=(0,s.useState)(!1),[a,n]=(0,s.useState)(null),[b,l]=(0,s.useState)(null),[_,j]=(0,s.useState)(0);I.current=()=>null;let R=h()?.email?0:1,$=R===0?h()?.email||"":h()?.phoneNumber||"",W=U-500;return(0,s.useEffect)(()=>{if(_){let i=setTimeout(()=>{j(_-1)},1e3);return()=>clearTimeout(i)}},[_]),(0,s.useEffect)(()=>{if(c&&t&&x){if(E?.legal.requireUsersAcceptTerms&&!x.hasAcceptedTerms){let i=setTimeout(()=>{o("AffirmativeConsentScreen")},W);return()=>clearTimeout(i)}if(H(x,E.embeddedWallets)){let i=setTimeout(()=>{p({createWallet:{onSuccess:()=>{},onFailure:e=>{console.error(e),N({eventName:"embedded_wallet_creation_failure_logout",payload:{error:e,screen:"AwaitingPasswordlessCodeScreen"}}),C()},callAuthOnSuccessOnClose:!0}}),o("EmbeddedWalletOnAccountCreateScreen")},W);return()=>clearTimeout(i)}{O();let i=setTimeout(()=>M({shouldCallAuthOnSuccess:!0,isSuccess:!0}),U);return()=>clearTimeout(i)}}},[c,t,x]),(0,s.useEffect)(()=>{if(a&&b===0){let i=setTimeout(()=>{n(null),l(null),document.querySelector("input[name=code-0]")?.focus()},1400);return()=>clearTimeout(i)}},[a,b]),(0,r.jsx)(se,{contactMethod:$,authFlow:R===0?"email":"sms",emailDomain:E?.appearance.emailDomain,appName:E?.name,whatsAppEnabled:y,onBack:()=>S(),onCodeSubmit:async i=>{try{await D(i),u(!0)}catch(e){if(e instanceof f&&e.privyErrorCode===v.INVALID_CREDENTIALS)n("Invalid or expired verification code"),l(0);else if(e instanceof f&&e.privyErrorCode===v.CANNOT_LINK_MORE_OF_TYPE)n(e.message);else{if(e instanceof f&&e.privyErrorCode===v.USER_LIMIT_REACHED)return console.error(new V(e).toString()),void o("UserLimitReachedScreen");if(e instanceof f&&e.privyErrorCode===v.USER_DOES_NOT_EXIST)return void o("AccountNotFoundScreen");if(e instanceof f&&e.privyErrorCode===v.LINKED_TO_ANOTHER_USER)return p({errorModalData:{error:e,previousScreen:d??"AwaitingPasswordlessCodeScreen"}}),void o("ErrorScreen",!1);if(e instanceof f&&e.privyErrorCode===v.DISALLOWED_PLUS_EMAIL)return p({inlineError:{error:e}}),void o("ConnectOrCreateScreen",!1);if(e instanceof f&&e.privyErrorCode===v.ACCOUNT_TRANSFER_REQUIRED&&e.data?.data?.nonce)return p({accountTransfer:{nonce:e.data?.data?.nonce,account:$,displayName:e.data?.data?.account?.displayName,linkMethod:R===0?"email":"sms",embeddedWalletAddress:e.data?.data?.otherUser?.embeddedWalletAddress}}),void o("LinkConflictScreen");n("Issue verifying code"),l(0)}}},onResend:async()=>{j(30),R===0?await L():await m()},errorMessage:a||void 0,success:t,resendCountdown:_,onInvalidInput:i=>{n(i),l(1)},onClearError:()=>{b===1&&(n(null),l(null))}})}},de=g.div`
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  margin: auto;
  gap: 16px;
  flex-grow: 1;
  width: 100%;
`,pe=g.div`
  display: flex;
  flex-direction: column;
  width: 100%;
  gap: 12px;

  > div:first-child {
    display: flex;
    justify-content: center;
    gap: 0.5rem;
    width: 100%;
    border-radius: var(--privy-border-radius-sm);

    > input {
      border: 1px solid var(--privy-color-foreground-4);
      background: var(--privy-color-background);
      border-radius: var(--privy-border-radius-sm);
      padding: 8px 10px;
      height: 48px;
      width: 40px;
      text-align: center;
      font-size: 18px;
      font-weight: 600;
      color: var(--privy-color-foreground);
      transition: all 0.2s ease;
    }

    > input:focus {
      border: 1px solid var(--privy-color-foreground);
      box-shadow: 0 0 0 1px var(--privy-color-foreground);
    }

    > input:invalid {
      border: 1px solid var(--privy-color-error);
    }

    > input.success {
      border: 1px solid var(--privy-color-border-success);
      background: var(--privy-color-success-bg);
    }

    > input.fail {
      border: 1px solid var(--privy-color-border-error);
      background: var(--privy-color-error-bg);
      animation: shake 180ms;
      animation-iteration-count: 2;
    }
  }

  @keyframes shake {
    0% {
      transform: translate(1px, 0px);
    }
    33% {
      transform: translate(-1px, 0px);
    }
    67% {
      transform: translate(-1px, 0px);
    }
    100% {
      transform: translate(1px, 0px);
    }
  }
`,me=g.div`
  line-height: 20px;
  min-height: 20px;
  font-size: 14px;
  font-weight: 400;
  color: ${o=>o.$success?"var(--privy-color-success-dark)":o.$fail?"var(--privy-color-error-dark)":"transparent"};
  display: flex;
  justify-content: center;
  width: 100%;
  text-align: center;
`,ue=g.div`
  display: flex;
  gap: 8px;
  align-items: center;
  justify-content: center;
  width: 100%;
  color: var(--privy-color-foreground-2);
`,fe=g.div`
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--privy-border-radius-sm);
  padding: 2px 8px;
  gap: 4px;
  background: var(--privy-color-background-2);
  color: var(--privy-color-foreground-2);
`,re=g.span`
  font-weight: 500;
  word-break: break-all;
  color: var(--privy-color-foreground);
`;export{Le as AwaitingPasswordlessCodeScreen,se as AwaitingPasswordlessCodeScreenView,Le as default};
