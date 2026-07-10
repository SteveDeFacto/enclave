import{a as Q}from"./chunk-EU6P3FU6.js";import{a as E}from"./chunk-RX57H4PI.js";import{a as P}from"./chunk-E4HNCINF.js";import{a as ee,b as V}from"./chunk-EIKQ77TI.js";import{a as q}from"./chunk-KPGNEO6M.js";import{a as B}from"./chunk-6PFHC3TA.js";import"./chunk-6KIN4EGD.js";import{e as z,o as W}from"./chunk-I3B2SZVL.js";import"./chunk-LSJ7DHXG.js";import{i as j}from"./chunk-LAOCC7HV.js";import"./chunk-RX72V2DT.js";import"./chunk-BA2HXBNG.js";import"./chunk-M6F3L6JA.js";import"./chunk-ISE4SGOS.js";import"./chunk-QAOMSF4E.js";import"./chunk-L35YQFWA.js";import"./chunk-IKQFIZGK.js";import"./chunk-IJDSLHK6.js";import"./chunk-5GDNIVMJ.js";import"./chunk-7GRE4WMZ.js";import"./chunk-V6FGMHEW.js";import"./chunk-5IEIH52H.js";import"./chunk-IV5FR2YO.js";import{b as D}from"./chunk-FGSKM2Q7.js";import{B as l,F as $,Wa as a,e as I,jb as M,ka as Z,r as N}from"./chunk-DHATLY5R.js";import"./chunk-QCZJZLKO.js";import{ab as U,xa as C}from"./chunk-BMCS4PVW.js";import"./chunk-2HUGHRMV.js";import{a as Y,b as G}from"./chunk-AKQZC4JI.js";import"./chunk-3XBTBSJO.js";import"./chunk-VGKAVQRI.js";import"./chunk-JG6YPVA3.js";import"./chunk-TMJMA6BR.js";import"./chunk-JTYV7RXW.js";import{e as x}from"./chunk-KL2DZ7E2.js";var e=x(G(),1),s=x(Y(),1),y=x(Z(),1);var Le=x(ee(),1);var re=a.div`
  width: 100%;
`,te=a.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  padding: 0.75rem;
  height: 56px;
  background: ${r=>r.$disabled?"var(--privy-color-background-2)":"var(--privy-color-background)"};
  border: 1px solid var(--privy-color-foreground-4);
  border-radius: var(--privy-border-radius-md);

  &:hover {
    border-color: ${r=>r.$disabled?"var(--privy-color-foreground-4)":"var(--privy-color-foreground-3)"};
  }
`,oe=a.div`
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
`,H=a.span`
  display: block;
  font-size: 16px;
  line-height: 24px;
  color: ${r=>r.$disabled?"var(--privy-color-foreground-2)":"var(--privy-color-foreground)"};
  overflow: hidden;
  text-overflow: ellipsis;
  /* Use single-line truncation without nowrap to respect container width */
  display: -webkit-box;
  -webkit-line-clamp: 1;
  -webkit-box-orient: vertical;
  word-break: break-all;

  @media (min-width: 441px) {
    font-size: 14px;
    line-height: 20px;
  }
`,ie=a(H)`
  color: var(--privy-color-foreground-3);
  font-style: italic;
`,ae=a(P)`
  margin-bottom: 0.5rem;
`,ne=a(j)`
  && {
    gap: 0.375rem;
    font-size: 14px;
    flex-shrink: 0;
  }
`,se=({value:r,title:m,placeholder:c,className:t,showCopyButton:d=!0,truncate:n,maxLength:p=40,disabled:u=!1})=>{let[h,b]=(0,s.useState)(!1),T=n&&r?((o,k,f)=>{if((o=o.startsWith("https://")?o.slice(8):o).length<=f)return o;if(k==="middle"){let w=Math.ceil(f/2)-2,A=Math.floor(f/2)-1;return`${o.slice(0,w)}...${o.slice(-A)}`}return`${o.slice(0,f-3)}...`})(r,n,p):r;return(0,s.useEffect)((()=>{if(h){let o=setTimeout((()=>b(!1)),3e3);return()=>clearTimeout(o)}}),[h]),(0,e.jsxs)(re,{className:t,children:[m&&(0,e.jsx)(ae,{children:m}),(0,e.jsxs)(te,{$disabled:u,children:[(0,e.jsx)(oe,{children:r?(0,e.jsx)(H,{$disabled:u,title:r,children:T}):(0,e.jsx)(ie,{$disabled:u,children:c||"No value"})}),d&&r&&(0,e.jsx)(ne,{onClick:function(o){o.stopPropagation(),navigator.clipboard.writeText(r).then((()=>b(!0))).catch(console.error)},size:"sm",children:(0,e.jsxs)(e.Fragment,h?{children:["Copied",(0,e.jsx)(z,{size:14})]}:{children:["Copy",(0,e.jsx)(W,{size:14})]})})]})]})},le=({connectUri:r,loading:m,success:c,errorMessage:t,onBack:d,onClose:n,onOpenFarcaster:p})=>(0,e.jsx)(B,y.isMobile||m?y.isIOS?{title:t?t.message:"Sign in with Farcaster",subtitle:t?t.detail:"To sign in with Farcaster, please open the Farcaster app.",icon:E,iconVariant:"loading",iconLoadingStatus:{success:c,fail:!!t},primaryCta:r&&p?{label:"Open Farcaster app",onClick:p}:void 0,onBack:d,onClose:n,watermark:!0}:{title:t?t.message:"Signing in with Farcaster",subtitle:t?t.detail:"This should only take a moment",icon:E,iconVariant:"loading",iconLoadingStatus:{success:c,fail:!!t},onBack:d,onClose:n,watermark:!0,children:r&&y.isMobile&&(0,e.jsx)(ce,{children:(0,e.jsx)(Q,{text:"Take me to Farcaster",url:r,color:"#8a63d2"})})}:{title:"Sign in with Farcaster",subtitle:"Scan with your phone's camera to continue.",onBack:d,onClose:n,watermark:!0,children:(0,e.jsxs)(de,{children:[(0,e.jsx)(me,{children:r?(0,e.jsx)(V,{url:r,size:275,squareLogoElement:E}):(0,e.jsx)(he,{children:(0,e.jsx)(M,{})})}),(0,e.jsxs)(pe,{children:[(0,e.jsx)(ue,{children:"Or copy this link and paste it into a phone browser to open the Farcaster app."}),r&&(0,e.jsx)(se,{value:r,truncate:"end",maxLength:30,showCopyButton:!0,disabled:!0})]})]})}),Ue={component:()=>{let{authenticated:r,logout:m,ready:c,user:t}=N(),{lastScreen:d,navigate:n,navigateBack:p,setModalData:u}=D(),h=U(),{getAuthFlow:b,loginWithFarcaster:T,closePrivyModal:o,createAnalyticsEvent:k}=I(),[f,w]=(0,s.useState)(void 0),[A,J]=(0,s.useState)(!1),[S,K]=(0,s.useState)(!1),F=(0,s.useRef)([]),R=b(),O=R?.meta.connectUri;return(0,s.useEffect)((()=>{let g=Date.now(),_=setInterval((async()=>{let L=await R.pollForReady.execute(),X=Date.now()-g;if(L){clearInterval(_),J(!0);try{await T(),K(!0)}catch(i){let v={retryable:!1,message:"Authentication failed"};if(i?.privyErrorCode===l.ALLOWLIST_REJECTED)return void n("AllowlistRejectionScreen");if(i?.privyErrorCode===l.USER_LIMIT_REACHED)return console.error(new $(i).toString()),void n("UserLimitReachedScreen");if(i?.privyErrorCode===l.USER_DOES_NOT_EXIST)return void n("AccountNotFoundScreen");if(i?.privyErrorCode===l.LINKED_TO_ANOTHER_USER)v.detail=i.message??"This account has already been linked to another user.";else{if(i?.privyErrorCode===l.ACCOUNT_TRANSFER_REQUIRED&&i.data?.data?.nonce)return u({accountTransfer:{nonce:i.data?.data?.nonce,account:i.data?.data?.subject,displayName:i.data?.data?.account?.displayName,linkMethod:"farcaster",embeddedWalletAddress:i.data?.data?.otherUser?.embeddedWalletAddress,farcasterEmbeddedAddress:i.data?.data?.otherUser?.farcasterEmbeddedAddress}}),void n("LinkConflictScreen");i?.privyErrorCode===l.INVALID_CREDENTIALS?(v.retryable=!0,v.detail="Something went wrong. Try again."):i?.privyErrorCode===l.TOO_MANY_REQUESTS&&(v.detail="Too many requests. Please wait before trying again.")}w(v)}}else X>12e4&&(clearInterval(_),w({retryable:!0,message:"Authentication failed",detail:"The request timed out. Try again."}))}),2e3);return()=>{clearInterval(_),F.current.forEach((L=>clearTimeout(L)))}}),[]),(0,s.useEffect)((()=>{if(c&&r&&S&&t){if(h?.legal.requireUsersAcceptTerms&&!t.hasAcceptedTerms){let g=setTimeout((()=>{n("AffirmativeConsentScreen")}),C);return()=>clearTimeout(g)}S&&(q(t,h.embeddedWallets)?F.current.push(setTimeout((()=>{u({createWallet:{onSuccess:()=>{},onFailure:g=>{console.error(g),k({eventName:"embedded_wallet_creation_failure_logout",payload:{error:g,screen:"FarcasterConnectStatusScreen"}}),m()},callAuthOnSuccessOnClose:!0}}),n("EmbeddedWalletOnAccountCreateScreen")}),C)):F.current.push(setTimeout((()=>o({shouldCallAuthOnSuccess:!0,isSuccess:!0})),C)))}}),[S,c,r,t]),(0,e.jsx)(le,{connectUri:O,loading:A,success:S,errorMessage:f,onBack:d?p:void 0,onClose:o,onOpenFarcaster:()=>{O&&(window.location.href=O)}})}},ce=a.div`
  margin-top: 24px;
`,de=a.div`
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 24px;
`,me=a.div`
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 275px;
`,pe=a.div`
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16px;
`,ue=a.div`
  font-size: 0.875rem;
  text-align: center;
  color: var(--privy-color-foreground-2);
`,he=a.div`
  position: relative;
  width: 82px;
  height: 82px;
`;export{Ue as FarcasterConnectStatusScreen,le as FarcasterConnectStatusView,Ue as default};
