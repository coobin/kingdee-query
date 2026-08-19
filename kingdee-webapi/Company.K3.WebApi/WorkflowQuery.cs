using System;
using System.Collections.Generic;
using System.Data;
using System.Globalization;
using Kingdee.BOS;
using Kingdee.BOS.App.Data;
using Kingdee.BOS.Orm.DataEntity;
using Kingdee.BOS.ServiceFacade.KDServiceFx;
using Kingdee.BOS.WebApi.ServicesStub;
using Newtonsoft.Json.Linq;

namespace Company.K3.WebApi
{
    /// <summary>
    /// 只读查询当前登录用户发起的在审流程。
    /// 依赖金蝶 9.0.0.20240711 对应 SDK，程序集名称：Company.K3.WebApi。
    /// </summary>
    public class WorkflowQuery : AbstractWebApiBusinessService
    {
        private const int LocaleId = 2052;

        public WorkflowQuery(KDServiceContext context)
            : base(context)
        {
        }

        /// <summary>
        /// 参数示例：{"Scope":"Mine","Number":"FYBX20260803000026"}
        /// Number 和 FormId 可选；发起人始终取当前金蝶登录上下文，不接受外部传入。
        /// </summary>
        public JObject GetMyProgress(string parameter)
        {
            JObject request = ParseRequest(parameter);
            string billNumber = LimitText(request["Number"] ?? request["BillNumber"], 200);
            string formId = LimitText(request["FormId"], 100);
            Context context = this.KDContext.Session.AppContext;
            int userId = Convert.ToInt32(context.UserId, CultureInfo.InvariantCulture);

            const string sql = @"/*dialect*/
SELECT TOP 1000
       p.FPROCINSTID AS PROCESS_INSTANCE_ID,
       p.FNUMBER AS PROCESS_NUMBER,
       p.FBILLNO AS BILL_NO,
       p.FCREATETIME AS CREATED_TIME,
       p.FSTATUS AS PROCESS_STATUS,
       p.FORIGINATORID AS ORIGINATOR_ID,
       p.FPROCDEFID AS PROCESS_DEFINITION_ID,
       dl.FDISPLAYNAME AS PROCESS_NAME,
       m.FOBJECTTYPEID AS FORM_ID,
       m.FKEYVALUE AS BILL_ID,
       a.FACTINSTID AS ACTIVITY_INSTANCE_ID,
       a.FACTIVITYID AS ACTIVITY_ID,
       COALESCE(al.FACTIVITYNAME, acl.FACTNAME) AS NODE_NAME,
       s.FASSIGNID AS ASSIGN_ID,
       s.FCREATETIME AS ARRIVAL_TIME,
       al.FASSIGNNAME AS ASSIGN_NAME,
       s.FRECEIVERNAMES AS RECEIVER_NAMES,
       r.FRECEIVERID AS RECEIVER_ID,
       ru.FUSERACCOUNT AS RECEIVER_ACCOUNT,
       ru.FNAME AS RECEIVER_NAME
  FROM T_WF_PROCINST p
  JOIN T_SEC_USER u
    ON u.FUSERID = p.FORIGINATORID
  LEFT JOIN T_WF_PROCDEF_L dl
    ON dl.FPROCDEFID = p.FPROCDEFID
   AND dl.FLOCALEID = @LocaleId
  LEFT JOIN T_WF_PIBIMAP m
    ON m.FPROCINSTID = p.FPROCINSTID
  LEFT JOIN T_WF_ACTINST a
    ON a.FPROCINSTID = p.FPROCINSTID
   AND a.FSTATUS = '2'
   AND a.FCOMPLETEDTIME IS NULL
  LEFT JOIN T_WF_ACTINST_L acl
    ON acl.FACTINSTID = a.FACTINSTID
   AND acl.FLOCALEID = @LocaleId
  LEFT JOIN T_WF_ASSIGN s
    ON s.FACTINSTID = a.FACTINSTID
   AND s.FSTATUS = '0'
  LEFT JOIN T_WF_ASSIGN_L al
    ON al.FASSIGNID = s.FASSIGNID
   AND al.FLOCALEID = @LocaleId
  LEFT JOIN T_WF_RECEIVER r
    ON r.FASSIGNID = s.FASSIGNID
  LEFT JOIN T_SEC_USER ru
    ON ru.FUSERID = r.FRECEIVERID
 WHERE p.FORIGINATORID = @UserId
   AND p.FSTATUS = '2'
   AND p.FCOMPLETETIME IS NULL
   AND (@BillNumber = N'' OR p.FBILLNO = @BillNumber)
   AND (@FormId = N'' OR m.FOBJECTTYPEID = @FormId)
 ORDER BY p.FCREATETIME DESC";

            DynamicObjectCollection rows = DBUtils.ExecuteDynamicObject(
                context,
                sql,
                paramList: new SqlParam[]
                {
                    new SqlParam("@UserId", DbType.Int32, userId),
                    new SqlParam("@LocaleId", DbType.Int32, LocaleId),
                    new SqlParam("@BillNumber", DbType.String, billNumber),
                    new SqlParam("@FormId", DbType.String, formId),
                });

            JArray data = new JArray();
            var processMap = new Dictionary<string, JObject>(StringComparer.OrdinalIgnoreCase);
            var nodeMap = new Dictionary<string, JObject>(StringComparer.OrdinalIgnoreCase);
            var handlerMap = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

            foreach (DynamicObject row in rows)
            {
                string processId = Text(row, "PROCESS_INSTANCE_ID");
                if (string.IsNullOrWhiteSpace(processId)) continue;

                JObject process;
                if (!processMap.TryGetValue(processId, out process))
                {
                    process = new JObject();
                    process.Add("ProcessInstanceId", processId);
                    process.Add("ProcessNumber", Text(row, "PROCESS_NUMBER"));
                    process.Add("BillNo", Text(row, "BILL_NO"));
                    process.Add("FormId", Text(row, "FORM_ID"));
                    process.Add("BillId", Text(row, "BILL_ID"));
                    process.Add("ProcessName", Text(row, "PROCESS_NAME"));
                    process.Add("CreatedTime", DateText(row, "CREATED_TIME"));
                    process.Add("Status", Text(row, "PROCESS_STATUS"));
                    process.Add("StatusName", "审批中");
                    process.Add("CurrentNodes", new JArray());
                    processMap.Add(processId, process);
                    data.Add(process);
                }

                string activityId = Text(row, "ACTIVITY_INSTANCE_ID");
                if (string.IsNullOrWhiteSpace(activityId)) continue;
                string nodeKey = processId + "|" + activityId;
                JObject node;
                if (!nodeMap.TryGetValue(nodeKey, out node))
                {
                    node = new JObject();
                    node.Add("ActivityId", Text(row, "ACTIVITY_ID"));
                    node.Add("NodeName", Text(row, "NODE_NAME"));
                    node.Add("AssignmentName", Text(row, "ASSIGN_NAME"));
                    node.Add("ArrivalTime", DateText(row, "ARRIVAL_TIME"));
                    node.Add("Handlers", new JArray());
                    ((JArray)process["CurrentNodes"]).Add(node);
                    nodeMap.Add(nodeKey, node);
                }

                string receiverId = Text(row, "RECEIVER_ID");
                string receiverAccount = Text(row, "RECEIVER_ACCOUNT");
                string receiverName = Text(row, "RECEIVER_NAME");
                if (string.IsNullOrWhiteSpace(receiverName)) receiverName = Text(row, "RECEIVER_NAMES");
                string handlerKey = nodeKey + "|" + receiverId + "|" + receiverAccount + "|" + receiverName;
                if (!handlerMap.Add(handlerKey) || string.IsNullOrWhiteSpace(receiverName + receiverAccount)) continue;

                JObject handler = new JObject();
                handler.Add("Id", receiverId);
                handler.Add("Account", receiverAccount);
                handler.Add("Name", receiverName);
                ((JArray)node["Handlers"]).Add(handler);
            }

            JObject result = new JObject();
            result.Add("IsSuccess", true);
            result.Add("UserId", userId);
            result.Add("UserName", Convert.ToString(context.UserName, CultureInfo.InvariantCulture));
            result.Add("Scope", "Mine");
            result.Add("Count", data.Count);
            result.Add("Truncated", rows.Count >= 1000);
            result.Add("Rows", data);
            return result;
        }

        private static JObject ParseRequest(string parameter)
        {
            if (string.IsNullOrWhiteSpace(parameter)) return new JObject();
            JObject request = JObject.Parse(parameter);
            string scope = LimitText(request["Scope"], 20);
            if (!string.IsNullOrWhiteSpace(scope) && !scope.Equals("Mine", StringComparison.OrdinalIgnoreCase))
            {
                throw new ArgumentException("Scope 只能是 Mine。");
            }
            return request;
        }

        private static string LimitText(JToken value, int maxLength)
        {
            string text = value == null ? string.Empty : Convert.ToString(value, CultureInfo.InvariantCulture).Trim();
            return text.Length <= maxLength ? text : text.Substring(0, maxLength);
        }

        private static string Text(DynamicObject row, string key)
        {
            object value = row[key];
            return value == null || value == DBNull.Value ? string.Empty : Convert.ToString(value, CultureInfo.InvariantCulture);
        }

        private static string DateText(DynamicObject row, string key)
        {
            object value = row[key];
            if (value == null || value == DBNull.Value) return string.Empty;
            DateTime date = Convert.ToDateTime(value, CultureInfo.InvariantCulture);
            return date.ToString("yyyy-MM-dd'T'HH:mm:ss.fff", CultureInfo.InvariantCulture);
        }
    }
}
