//+------------------------------------------------------------------+
//| DEWA Sniper EA MT5 V1.0                                          |
//| Executes only SNIPER signal from DEWA web API                    |
//| TP1 first. TP2 after TP1. TP3 after TP2. If SL hit -> close all. |
//+------------------------------------------------------------------+
#property strict
#include <Trade/Trade.mqh>
CTrade trade;

input string SignalURL = "https://dewa-smc-v64.onrender.com/api/ea/latest-signal";
input string MemberEmail = "";
input string EAApiKey = "";
input string TimeframeText = "5m";

input double LotTP1 = 0.01;
input double LotTP2 = 0.01;
input double LotTP3 = 0.01;

input bool EnableTP2 = true;
input bool EnableTP3 = true;

input int CheckSeconds = 20;
input int MaxSpreadPoints = 300;
input long Magic = 696969;

string lastKey="";
int stage=0;
double sigEntry=0,sigTP1=0,sigTP2=0,sigTP3=0,sigSL=0;
string sigSide="";

string UrlEncode(string s)
{
   StringReplace(s,"@","%40");
   StringReplace(s,"/","%2F");
   StringReplace(s," ","%20");
   return s;
}

bool HasDewaPosition()
{
   for(int i=PositionsTotal()-1;i>=0;i--)
   {
      ulong ticket=PositionGetTicket(i);
      if(PositionSelectByTicket(ticket))
      {
         if(PositionGetInteger(POSITION_MAGIC)==Magic && PositionGetString(POSITION_SYMBOL)==_Symbol)
            return true;
      }
   }
   return false;
}

void CloseAllDewa()
{
   for(int i=PositionsTotal()-1;i>=0;i--)
   {
      ulong ticket=PositionGetTicket(i);
      if(PositionSelectByTicket(ticket))
      {
         if(PositionGetInteger(POSITION_MAGIC)==Magic && PositionGetString(POSITION_SYMBOL)==_Symbol)
            trade.PositionClose(ticket);
      }
   }
}

double JsonNumber(string json,string key)
{
   string p="\""+key+"\":";
   int i=StringFind(json,p);
   if(i<0)return 0;
   i+=StringLen(p);
   while(i<StringLen(json))
   {
      ushort ch=StringGetCharacter(json,i);
      if(ch!=' ' && ch!='"')break;
      i++;
   }
   int j=i;
   while(j<StringLen(json))
   {
      ushort ch=StringGetCharacter(json,j);
      if(ch==',' || ch=='}' || ch=='"')break;
      j++;
   }
   return StringToDouble(StringSubstr(json,i,j-i));
}

string JsonString(string json,string key)
{
   string p="\""+key+"\":";
   int i=StringFind(json,p);
   if(i<0)return "";
   i+=StringLen(p);
   while(i<StringLen(json) && StringGetCharacter(json,i)!='"')i++;
   i++;
   int j=i;
   while(j<StringLen(json) && StringGetCharacter(json,j)!='"')j++;
   return StringSubstr(json,i,j-i);
}

bool FetchSignal()
{
   string url=SignalURL+
      "?key="+EAApiKey+
      "&email="+UrlEncode(MemberEmail)+
      "&symbol="+_Symbol+
      "&tf="+UrlEncode(TimeframeText)+
      "&mt5="+IntegerToString((int)AccountInfoInteger(ACCOUNT_LOGIN));

   char post[],result[];
   string headers;
   ResetLastError();

   int code=WebRequest("GET",url,"",10000,post,result,headers);
   if(code!=200)
   {
      Print("DEWA EA WebRequest failed. code=",code," err=",GetLastError());
      return false;
   }

   string json=CharArrayToString(result);
   if(StringFind(json,"\"signal\":null")>=0)return false;

   string signal=JsonString(json,"signal");
   string engine=JsonString(json,"engine");

   if(StringFind(engine,"SNIPER")<0)return false;
   if(signal!="OPEN LONG" && signal!="OPEN SHORT")return false;

   double entry=JsonNumber(json,"entry");
   double tp1=JsonNumber(json,"tp1");
   double tp2=JsonNumber(json,"tp2");
   double tp3=JsonNumber(json,"tp3");
   double sl=JsonNumber(json,"sl");

   if(entry<=0 || tp1<=0 || sl<=0)return false;

   string key=signal+"-"+DoubleToString(entry,_Digits);
   if(key==lastKey)return false;

   sigSide=signal;
   sigEntry=entry;
   sigTP1=tp1;
   sigTP2=tp2;
   sigTP3=tp3;
   sigSL=sl;
   lastKey=key;
   stage=0;

   Print("New DEWA SNIPER signal: ",signal," entry=",entry," tp1=",tp1," tp2=",tp2," tp3=",tp3," sl=",sl);
   return true;
}

bool OpenTrade(double lot,double sl,double tp,string comment)
{
   if(lot<=0)return false;

   int spread=(int)SymbolInfoInteger(_Symbol,SYMBOL_SPREAD);
   if(spread>MaxSpreadPoints)
   {
      Print("Spread too high: ",spread);
      return false;
   }

   trade.SetExpertMagicNumber(Magic);

   bool ok=false;
   if(sigSide=="OPEN LONG")
      ok=trade.Buy(lot,_Symbol,0,sl,tp,comment);
   else if(sigSide=="OPEN SHORT")
      ok=trade.Sell(lot,_Symbol,0,sl,tp,comment);

   if(!ok)Print("Open trade failed: ",trade.ResultRetcode()," ",trade.ResultRetcodeDescription());
   return ok;
}

void ManageStages()
{
   if(stage==0 && !HasDewaPosition())
   {
      if(OpenTrade(LotTP1,sigSL,sigTP1,"DEWA TP1"))stage=1;
      return;
   }

   if(stage==1 && !HasDewaPosition())
   {
      if(!EnableTP2){stage=99;return;}

      double sl=sigTP1;
      if(OpenTrade(LotTP2,sl,sigTP2,"DEWA TP2"))stage=2;
      return;
   }

   if(stage==2 && !HasDewaPosition())
   {
      if(!EnableTP3){stage=99;return;}

      double sl=sigTP2;
      if(OpenTrade(LotTP3,sl,sigTP3,"DEWA TP3"))stage=3;
      return;
   }

   if(stage==3 && !HasDewaPosition())
      stage=99;
}

int OnInit()
{
   EventSetTimer(CheckSeconds);
   trade.SetExpertMagicNumber(Magic);
   Print("DEWA Sniper EA started.");
   Print("MT5: add your Render URL in Tools > Options > Expert Advisors > Allow WebRequest.");
   return(INIT_SUCCEEDED);
}

void OnDeinit(const int reason)
{
   EventKillTimer();
}

void OnTimer()
{
   if(stage>0 && stage<99)
   {
      ManageStages();
      return;
   }

   if(!HasDewaPosition())
   {
      if(FetchSignal())
         ManageStages();
   }
}

void OnTradeTransaction(const MqlTradeTransaction &trans,const MqlTradeRequest &request,const MqlTradeResult &result)
{
   if(trans.type==TRADE_TRANSACTION_DEAL_ADD)
   {
      HistorySelect(TimeCurrent()-86400,TimeCurrent());
      ulong deal=trans.deal;
      if(HistoryDealSelect(deal))
      {
         long magic=HistoryDealGetInteger(deal,DEAL_MAGIC);
         string symbol=HistoryDealGetString(deal,DEAL_SYMBOL);
         long entry=HistoryDealGetInteger(deal,DEAL_ENTRY);
         double profit=HistoryDealGetDouble(deal,DEAL_PROFIT);

         if(magic==Magic && symbol==_Symbol && entry==DEAL_ENTRY_OUT && profit<0)
         {
            Print("DEWA EA detected SL/loss. Closing all DEWA positions.");
            CloseAllDewa();
            stage=99;
         }
      }
   }
}
