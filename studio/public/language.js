(function(){
  "use strict";
  var saved="";
  try{saved=localStorage.getItem("icha-language")||"";}catch(_){}
  var browser=(navigator.languages&&navigator.languages[0]||navigator.language||"en").toLowerCase().split("-")[0];
  var target=saved||browser;
  var started=false;
  function addPicker(){
    var header=document.querySelector("header");
    if(!header||document.getElementById("icha-language-picker"))return;
    var wrap=document.createElement("label");
    wrap.id="icha-language-picker";
    wrap.style.cssText="display:inline-flex;align-items:center;gap:7px;margin:8px 0 8px auto;color:#c5d0e2;font:13px system-ui,sans-serif;white-space:nowrap";
    wrap.appendChild(document.createTextNode("Language"));
    var select=document.createElement("select");
    select.id="icha-language-select";
    select.setAttribute("aria-label","Choose website language");
    select.style.cssText="max-width:150px;min-height:40px;padding:7px 10px;border-radius:9px;border:1px solid #ffffff35;background:#111827;color:#fff;font:inherit";
    select.innerHTML='<option value="">Loading languages…</option>';
    wrap.appendChild(select);
    header.appendChild(wrap);
    var hidden=document.createElement("div");
    hidden.id="google_translate_element";
    hidden.style.cssText="position:absolute!important;left:-9999px!important;top:-9999px!important";
    document.body.appendChild(hidden);
  }
  function fillPicker(){
    var native=document.querySelector(".goog-te-combo");
    var picker=document.getElementById("icha-language-select");
    if(!native||!picker||picker.dataset.ready)return false;
    picker.innerHTML="";
    Array.prototype.forEach.call(native.options,function(opt){
      if(!opt.value)return;
      var copy=document.createElement("option");
      copy.value=opt.value;copy.textContent=opt.textContent;
      picker.appendChild(copy);
    });
    picker.dataset.ready="1";
    var desired=target;
    if(!Array.prototype.some.call(picker.options,function(o){return o.value===desired;}))desired="en";
    picker.value=desired;
    if(desired&&desired!=="en")apply(desired,false);
    picker.addEventListener("change",function(){
      var code=picker.value||"en";
      try{localStorage.setItem("icha-language",code);}catch(_){}
      target=code;apply(code,true);
    });
    return true;
  }
  function apply(code,save){
    var native=document.querySelector(".goog-te-combo");
    if(!native)return;
    native.value=code==="en"?"":code;
    native.dispatchEvent(new Event("change",{bubbles:true}));
    document.documentElement.lang=code||"en";
    if(save){try{localStorage.setItem("icha-language",code||"en");}catch(_){}}
  }
  window.googleTranslateElementInit=function(){
    if(started)return;started=true;
    try{new google.translate.TranslateElement({pageLanguage:"en",autoDisplay:false}, "google_translate_element");}catch(_){}
    var tries=0;
    var timer=setInterval(function(){
      tries++;
      if(fillPicker()||tries>80)clearInterval(timer);
    },250);
  };
  var css=document.createElement("style");
  css.textContent=".goog-te-banner-frame,.goog-te-balloon-frame{display:none!important}body{top:0!important}.skiptranslate{max-width:100%}#icha-language-picker{z-index:5}";
  document.head.appendChild(css);
  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",addPicker);else addPicker();
  var script=document.createElement("script");
  script.src="https://translate.google.com/translate_a/element.js?cb=googleTranslateElementInit";
  script.async=true;script.onerror=function(){var p=document.getElementById("icha-language-picker");if(p)p.lastChild.innerHTML='<option value="en">English</option>';};
  document.head.appendChild(script);
})();