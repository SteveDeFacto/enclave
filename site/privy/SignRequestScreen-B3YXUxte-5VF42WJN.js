import{a as k,b as I}from"./chunk-DCHHLDPD.js";import{a as P}from"./chunk-5PZTVNBH.js";import{g as O}from"./chunk-ARRVTVNF.js";import{a as z}from"./chunk-6PFHC3TA.js";import"./chunk-6KIN4EGD.js";import{G as N}from"./chunk-I3B2SZVL.js";import"./chunk-LSJ7DHXG.js";import"./chunk-LAOCC7HV.js";import{b as M}from"./chunk-FGSKM2Q7.js";import{Wa as m,ba as x,ca as C,e as v,ka as B,r as U}from"./chunk-DHATLY5R.js";import"./chunk-QCZJZLKO.js";import{J as y,Va as A,xa as L}from"./chunk-BMCS4PVW.js";import{v as D}from"./chunk-2HUGHRMV.js";import{a as K,b as Q}from"./chunk-AKQZC4JI.js";import"./chunk-VGKAVQRI.js";import"./chunk-JG6YPVA3.js";import{la as _,v as R}from"./chunk-TMJMA6BR.js";import"./chunk-JTYV7RXW.js";import{e as w}from"./chunk-KL2DZ7E2.js";var t=w(Q(),1);var a=w(K(),1);var Se=w(B(),1);var G=m.img`
  && {
    height: ${e=>e.size==="sm"?"65px":"140px"};
    width: ${e=>e.size==="sm"?"65px":"140px"};
    border-radius: 16px;
    margin-bottom: 12px;
  }
`,X=e=>{if(!R(e))return e;try{let r=_(e);return r.includes("\uFFFD")?e:r}catch{return e}},Y=e=>{try{let r=D.decode(e),i=new TextDecoder().decode(r);return i.includes("\uFFFD")?e:i}catch{return e}},Z=e=>{let{types:r,primaryType:i,...l}=e.typedData;return(0,t.jsxs)(t.Fragment,{children:[(0,t.jsx)(ie,{data:l}),(0,t.jsx)(P,{text:(n=e.typedData,JSON.stringify(n,null,2)),itemName:"full payload to clipboard"})," "]});var n},ee=({method:e,messageData:r,copy:i,iconUrl:l,isLoading:n,success:u,walletProxyIsLoading:g,errorMessage:h,isCancellable:c,onSign:p,onCancel:S,onClose:d})=>(0,t.jsx)(z,{title:i.title,subtitle:i.description,showClose:!0,onClose:d,icon:N,iconVariant:"subtle",helpText:h?(0,t.jsx)(re,{children:h}):void 0,primaryCta:{label:i.buttonText,onClick:p,disabled:n||u||g,loading:n},secondaryCta:c?{label:"Not now",onClick:S,disabled:n||u||g}:void 0,watermark:!0,children:(0,t.jsxs)(O,{children:[l?(0,t.jsx)(G,{style:{alignSelf:"center"},size:"sm",src:l,alt:"app image"}):null,(0,t.jsxs)(te,{children:[e==="personal_sign"&&(0,t.jsx)(j,{children:X(r)}),e==="eth_signTypedData_v4"&&(0,t.jsx)(Z,{typedData:r}),e==="solana_signMessage"&&(0,t.jsx)(j,{children:Y(r)})]})]})}),Ee={component:()=>{let{authenticated:e}=U(),{initializeWalletProxy:r,closePrivyModal:i}=v(),{navigate:l,data:n,onUserCloseViaDialogOrKeybindRef:u}=M(),[g,h]=(0,a.useState)(!0),[c,p]=(0,a.useState)(""),[S,d]=(0,a.useState)(),[E,T]=(0,a.useState)(null),[F,b]=(0,a.useState)(!1);(0,a.useEffect)((()=>{e||l("LandingScreen")}),[e]),(0,a.useEffect)((()=>{r(A).then((o=>{h(!1),o||(p("An error has occurred, please try again."),d(new C(new x(c,y.E32603_DEFAULT_INTERNAL_ERROR.eipCode))))}))}),[]);let{method:q,data:V,confirmAndSign:J,onSuccess:W,onFailure:$,uiOptions:s}=n.signMessage,H={title:s?.title||"Sign message",description:s?.description||"Signing this message will not cost you any fees.",buttonText:s?.buttonText||"Sign and continue"},f=o=>{o?W(o):$(S||new C(new x("The user rejected the request.",y.E4001_USER_REJECTED_REQUEST.eipCode))),i({shouldCallAuthOnSuccess:!1}),setTimeout((()=>{T(null),p(""),d(void 0)}),200)};return u.current=()=>{f(E)},(0,t.jsx)(ee,{method:q,messageData:V,copy:H,iconUrl:s?.iconUrl&&typeof s.iconUrl=="string"?s.iconUrl:void 0,isLoading:F,success:E!==null,walletProxyIsLoading:g,errorMessage:c,isCancellable:s?.isCancellable,onSign:async()=>{b(!0),p("");try{let o=await J();T(o),b(!1),setTimeout((()=>{f(o)}),L)}catch(o){console.error(o),p("An error has occurred, please try again."),d(new C(new x(c,y.E32603_DEFAULT_INTERNAL_ERROR.eipCode))),b(!1)}},onCancel:()=>f(null),onClose:()=>f(E)})}},te=m.div`
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 16px;
`,re=m.p`
  && {
    margin: 0;
    width: 100%;
    text-align: center;
    color: var(--privy-color-error-dark);
    font-size: 14px;
    line-height: 22px;
  }
`,ie=m(I)`
  margin-top: 0;
`,j=m(k)`
  margin-top: 0;
`;export{Ee as SignRequestScreen,ee as SignRequestView,Ee as default};
