import{a as j}from"./chunk-5PZTVNBH.js";import{a as O}from"./chunk-EU6P3FU6.js";import{a as g}from"./chunk-RX57H4PI.js";import{a as P,b as I}from"./chunk-EIKQ77TI.js";import{a as T}from"./chunk-6PFHC3TA.js";import"./chunk-6KIN4EGD.js";import"./chunk-LSJ7DHXG.js";import"./chunk-LAOCC7HV.js";import"./chunk-RX72V2DT.js";import{b as C}from"./chunk-FGSKM2Q7.js";import{Wa as i,e as S,jb as F,ka as N}from"./chunk-DHATLY5R.js";import"./chunk-QCZJZLKO.js";import{ab as b,xa as w}from"./chunk-BMCS4PVW.js";import"./chunk-2HUGHRMV.js";import{a as M,b as E}from"./chunk-AKQZC4JI.js";import"./chunk-VGKAVQRI.js";import"./chunk-JG6YPVA3.js";import"./chunk-TMJMA6BR.js";import"./chunk-JTYV7RXW.js";import{e as f}from"./chunk-KL2DZ7E2.js";var e=f(E(),1),a=f(M(),1),m=f(N(),1);var ae=f(P(),1);var q="#8a63d2",R=({appName:p,loading:h,success:d,errorMessage:t,connectUri:r,onBack:o,onClose:n,onOpenFarcaster:s})=>(0,e.jsx)(T,m.isMobile||h?m.isIOS?{title:t?t.message:"Add a signer to Farcaster",subtitle:t?t.detail:`This will allow ${p} to add casts, likes, follows, and more on your behalf.`,icon:g,iconVariant:"loading",iconLoadingStatus:{success:d,fail:!!t},primaryCta:r&&s?{label:"Open Farcaster app",onClick:s}:void 0,onBack:o,onClose:n,watermark:!0}:{title:t?t.message:"Requesting signer from Farcaster",subtitle:t?t.detail:"This should only take a moment",icon:g,iconVariant:"loading",iconLoadingStatus:{success:d,fail:!!t},onBack:o,onClose:n,watermark:!0,children:r&&m.isMobile&&(0,e.jsx)(V,{children:(0,e.jsx)(O,{text:"Take me to Farcaster",url:r,color:q})})}:{title:"Add a signer to Farcaster",subtitle:`This will allow ${p} to add casts, likes, follows, and more on your behalf.`,onBack:o,onClose:n,watermark:!0,children:(0,e.jsxs)(z,{children:[(0,e.jsx)(D,{children:r?(0,e.jsx)(I,{url:r,size:275,squareLogoElement:g}):(0,e.jsx)(Q,{children:(0,e.jsx)(F,{})})}),(0,e.jsxs)(U,{children:[(0,e.jsx)($,{children:"Or copy this link and paste it into a phone browser to open the Farcaster app."}),r&&(0,e.jsx)(j,{text:r,itemName:"link",color:q})]})]})}),V=i.div`
  margin-top: 24px;
`,z=i.div`
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 24px;
`,D=i.div`
  padding: 24px;
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 275px;
`,U=i.div`
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16px;
`,$=i.div`
  font-size: 0.875rem;
  text-align: center;
  color: var(--privy-color-foreground-2);
`,Q=i.div`
  position: relative;
  width: 82px;
  height: 82px;
`,ie={component:()=>{let{lastScreen:p,navigateBack:h,data:d}=C(),t=b(),{requestFarcasterSignerStatus:r,closePrivyModal:o}=S(),[n,s]=(0,a.useState)(void 0),[B,k]=(0,a.useState)(!1),[_,x]=(0,a.useState)(!1),v=(0,a.useRef)([]),c=d?.farcasterSigner;(0,a.useEffect)((()=>{let A=Date.now(),l=setInterval((async()=>{if(!c?.public_key)return clearInterval(l),void s({retryable:!0,message:"Connect failed",detail:"Something went wrong. Please try again."});c.status==="approved"&&(clearInterval(l),k(!1),x(!0),v.current.push(setTimeout((()=>o({shouldCallAuthOnSuccess:!1,isSuccess:!0})),w)));let u=await r(c?.public_key),L=Date.now()-A;u.status==="approved"?(clearInterval(l),k(!1),x(!0),v.current.push(setTimeout((()=>o({shouldCallAuthOnSuccess:!1,isSuccess:!0})),w))):L>3e5?(clearInterval(l),s({retryable:!0,message:"Connect failed",detail:"The request timed out. Try again."})):u.status==="revoked"&&(clearInterval(l),s({retryable:!0,message:"Request rejected",detail:"The request was rejected. Please try again."}))}),2e3);return()=>{clearInterval(l),v.current.forEach((u=>clearTimeout(u)))}}),[]);let y=c?.status==="pending_approval"?c.signer_approval_url:void 0;return(0,e.jsx)(R,{appName:t.name,loading:B,success:_,errorMessage:n,connectUri:y,onBack:p?h:void 0,onClose:o,onOpenFarcaster:()=>{y&&(window.location.href=y)}})}};export{ie as FarcasterSignerStatusScreen,R as FarcasterSignerStatusView,ie as default};
